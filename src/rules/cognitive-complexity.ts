/*
 * eslint-plugin-sonarjs
 * Copyright (C) 2018 SonarSource SA
 * mailto:info AT sonarsource DOT com
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 3 of the License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program; if not, write to the Free Software Foundation,
 * Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301, USA.
 */
// https://jira.sonarsource.com/browse/RSPEC-3776

import { Rule } from "eslint";
import * as estree from "estree";
import { getParent, isIfStatement, isLogicalExpression } from "../utils/nodes";
import {
  getMainFunctionTokenLocation,
  getFirstToken,
  getFirstTokenAfter,
  report,
  IssueLocation,
  issueLocation,
} from "../utils/locations";

const DEFAULT_THRESHOLD = 15;

type LoopStatement =
  | estree.ForStatement
  | estree.ForInStatement
  | estree.ForOfStatement
  | estree.DoWhileStatement
  | estree.WhileStatement;

type OptionalLocation = estree.SourceLocation | null | undefined;

const rule: Rule.RuleModule = {
  meta: {
    schema: [
      { type: "integer", minimum: 0 },
      {
        // internal parameter
        enum: ["sonar-runtime", "metric"],
      },
    ],
  },
  create(context: Rule.RuleContext) {
    const threshold: number = getThreshold();
    const isFileComplexity: boolean = context.options.includes("metric");

    /** Complexity of the file */
    let fileComplexity = 0;

    /** Complexity of the current function if it is *not* considered nested to the first level function */
    let complexityIfNotNested: ComplexityPoint[] = [];

    /** Complexity of the current function if it is considered nested to the first level function */
    let complexityIfNested: ComplexityPoint[] = [];

    /** Current nesting level (number of enclosing control flow statements and functions) */
    let nesting = 0;

    /** Indicator if the current top level function has a structural (generated by control flow statements) complexity */
    let topLevelHasStructuralComplexity = false;

    /** Own (not including nested functions) complexity of the current top function */
    let topLevelOwnComplexity: ComplexityPoint[] = [];

    /** Nodes that should increase nesting level  */
    const nestingNodes: Set<estree.Node> = new Set();

    /** Set of already considered (with already computed complexity) logical expressions */
    const consideredLogicalExpressions: Set<estree.Node> = new Set();

    /** Stack of enclosing functions */
    const enclosingFunctions: estree.Function[] = [];

    let secondLevelFunctions: Array<{
      node: estree.Function;
      parent: estree.Node | undefined;
      complexityIfThisSecondaryIsTopLevel: ComplexityPoint[];
      complexityIfNested: ComplexityPoint[];
      loc: OptionalLocation;
    }> = [];

    return {
      ":function": (node: estree.Node) => {
        onEnterFunction(node as estree.Function);
      },
      ":function:exit"(node: estree.Node) {
        onLeaveFunction(node as estree.Function);
      },

      "*"(node: estree.Node) {
        if (nestingNodes.has(node)) {
          nesting++;
        }
      },
      "*:exit"(node: estree.Node) {
        if (nestingNodes.has(node)) {
          nesting--;
          nestingNodes.delete(node);
        }
      },
      Program() {
        fileComplexity = 0;
      },
      "Program:exit"(node: estree.Node) {
        if (isFileComplexity) {
          // as issues are the only communication channel of a rule
          // we pass data as serialized json as an issue message
          context.report({ node, message: fileComplexity.toString() });
        }
      },

      IfStatement(node: estree.Node) {
        visitIfStatement(node as estree.IfStatement);
      },
      ForStatement(node: estree.Node) {
        visitLoop(node as estree.ForStatement);
      },
      ForInStatement(node: estree.Node) {
        visitLoop(node as estree.ForInStatement);
      },
      ForOfStatement(node: estree.Node) {
        visitLoop(node as estree.ForOfStatement);
      },
      DoWhileStatement(node: estree.Node) {
        visitLoop(node as estree.DoWhileStatement);
      },
      WhileStatement(node: estree.Node) {
        visitLoop(node as estree.WhileStatement);
      },
      SwitchStatement(node: estree.Node) {
        visitSwitchStatement(node as estree.SwitchStatement);
      },
      ContinueStatement(node: estree.Node) {
        visitContinueOrBreakStatement(node as estree.ContinueStatement);
      },
      BreakStatement(node: estree.Node) {
        visitContinueOrBreakStatement(node as estree.BreakStatement);
      },
      CatchClause(node: estree.Node) {
        visitCatchClause(node as estree.CatchClause);
      },
      LogicalExpression(node: estree.Node) {
        visitLogicalExpression(node as estree.LogicalExpression);
      },
      ConditionalExpression(node: estree.Node) {
        visitConditionalExpression(node as estree.ConditionalExpression);
      },
    };

    function getThreshold() {
      return context.options[0] !== undefined ? context.options[0] : DEFAULT_THRESHOLD;
    }

    function onEnterFunction(node: estree.Function) {
      if (enclosingFunctions.length === 0) {
        // top level function
        topLevelHasStructuralComplexity = false;
        topLevelOwnComplexity = [];
        secondLevelFunctions = [];
      } else if (enclosingFunctions.length === 1) {
        // second level function
        complexityIfNotNested = [];
        complexityIfNested = [];
      } else {
        nesting++;
        nestingNodes.add(node);
      }
      enclosingFunctions.push(node);
    }

    function onLeaveFunction(node: estree.Function) {
      enclosingFunctions.pop();
      if (enclosingFunctions.length === 0) {
        // top level function
        if (topLevelHasStructuralComplexity) {
          let totalComplexity = topLevelOwnComplexity;
          secondLevelFunctions.forEach(secondLevelFunction => {
            totalComplexity = totalComplexity.concat(secondLevelFunction.complexityIfNested);
          });
          checkFunction(totalComplexity, getMainFunctionTokenLocation(node, getParent(context), context));
        } else {
          checkFunction(topLevelOwnComplexity, getMainFunctionTokenLocation(node, getParent(context), context));
          secondLevelFunctions.forEach(secondLevelFunction => {
            checkFunction(
              secondLevelFunction.complexityIfThisSecondaryIsTopLevel,
              getMainFunctionTokenLocation(secondLevelFunction.node, secondLevelFunction.parent, context),
            );
          });
        }
      } else if (enclosingFunctions.length === 1) {
        // second level function
        secondLevelFunctions.push({
          node,
          parent: getParent(context),
          complexityIfNested,
          complexityIfThisSecondaryIsTopLevel: complexityIfNotNested,
          loc: getMainFunctionTokenLocation(node, getParent(context), context),
        });
      } else {
        // complexity of third+ level functions is computed in their parent functions
        // so we never raise an issue for them
      }
    }

    function visitIfStatement(ifStatement: estree.IfStatement) {
      const parent = getParent(context);
      const { loc: ifLoc } = getFirstToken(ifStatement, context);
      // if the current `if` statement is `else if`, do not count it in structural complexity
      if (isIfStatement(parent) && parent.alternate === ifStatement) {
        addComplexity(ifLoc);
      } else {
        addStructuralComplexity(ifLoc);
      }

      // always increase nesting level inside `then` statement
      nestingNodes.add(ifStatement.consequent);

      // if `else` branch is not `else if` then
      // - increase nesting level inside `else` statement
      // - add +1 complexity
      if (ifStatement.alternate && !isIfStatement(ifStatement.alternate)) {
        nestingNodes.add(ifStatement.alternate);
        const elseTokenLoc = getFirstTokenAfter(ifStatement.consequent, context)!.loc;
        addComplexity(elseTokenLoc);
      }
    }

    function visitLoop(loop: LoopStatement) {
      addStructuralComplexity(getFirstToken(loop, context).loc);
      nestingNodes.add(loop.body);
    }

    function visitSwitchStatement(switchStatement: estree.SwitchStatement) {
      addStructuralComplexity(getFirstToken(switchStatement, context).loc);
      for (const switchCase of switchStatement.cases) {
        nestingNodes.add(switchCase);
      }
    }

    function visitContinueOrBreakStatement(statement: estree.ContinueStatement | estree.BreakStatement) {
      if (statement.label) {
        addComplexity(getFirstToken(statement, context).loc);
      }
    }

    function visitCatchClause(catchClause: estree.CatchClause) {
      addStructuralComplexity(getFirstToken(catchClause, context).loc);
      nestingNodes.add(catchClause.body);
    }

    function visitConditionalExpression(conditionalExpression: estree.ConditionalExpression) {
      const questionTokenLoc = getFirstTokenAfter(conditionalExpression.test, context)!.loc;
      addStructuralComplexity(questionTokenLoc);
      nestingNodes.add(conditionalExpression.consequent);
      nestingNodes.add(conditionalExpression.alternate);
    }

    function visitLogicalExpression(logicalExpression: estree.LogicalExpression) {
      if (!consideredLogicalExpressions.has(logicalExpression)) {
        const flattenedLogicalExpressions = flattenLogicalExpression(logicalExpression);

        let previous: estree.LogicalExpression | undefined;
        for (const current of flattenedLogicalExpressions) {
          if (!previous || previous.operator !== current.operator) {
            const operatorTokenLoc = getFirstTokenAfter(logicalExpression.left, context)!.loc;
            addComplexity(operatorTokenLoc);
          }
          previous = current;
        }
      }
    }

    function flattenLogicalExpression(node: estree.Node): estree.LogicalExpression[] {
      if (isLogicalExpression(node)) {
        consideredLogicalExpressions.add(node);
        return [...flattenLogicalExpression(node.left), node, ...flattenLogicalExpression(node.right)];
      }
      return [];
    }

    function addStructuralComplexity(location: estree.SourceLocation) {
      const added = nesting + 1;
      const complexityPoint = { complexity: added, location };
      if (enclosingFunctions.length === 0) {
        // top level scope
        fileComplexity += added;
      } else if (enclosingFunctions.length === 1) {
        // top level function
        topLevelHasStructuralComplexity = true;
        topLevelOwnComplexity.push(complexityPoint);
      } else {
        // second+ level function
        complexityIfNested.push({ complexity: added + 1, location });
        complexityIfNotNested.push(complexityPoint);
      }
    }

    function addComplexity(location: estree.SourceLocation) {
      const complexityPoint = { complexity: 1, location };
      if (enclosingFunctions.length === 0) {
        // top level scope
        fileComplexity += 1;
      } else if (enclosingFunctions.length === 1) {
        // top level function
        topLevelOwnComplexity.push(complexityPoint);
      } else {
        // second+ level function
        complexityIfNested.push(complexityPoint);
        complexityIfNotNested.push(complexityPoint);
      }
    }

    function checkFunction(complexity: ComplexityPoint[] = [], loc: estree.SourceLocation) {
      const complexityAmount = complexity.reduce((acc, cur) => acc + cur.complexity, 0);
      fileComplexity += complexityAmount;
      if (isFileComplexity) {
        return;
      }
      if (complexityAmount > threshold) {
        const secondaryLocations: IssueLocation[] = complexity.map(complexityPoint => {
          const { complexity, location } = complexityPoint;
          const message = complexity === 1 ? "+1" : `+${complexity} (incl. ${complexity - 1} for nesting)`;
          return issueLocation(location, undefined, message);
        });

        report(
          context,
          {
            message: `Refactor this function to reduce its Cognitive Complexity from ${complexityAmount} to the ${threshold} allowed.`,
            loc,
          },
          secondaryLocations,
          complexityAmount - threshold,
        );
      }
    }
  },
};

export = rule;

type ComplexityPoint = {
  complexity: number;
  location: estree.SourceLocation;
};
