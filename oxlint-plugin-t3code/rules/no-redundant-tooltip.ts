import { defineRule, type ESTree } from "@oxlint/plugins";

const name = (node: ESTree.JSXElement) =>
  node.openingElement.name.type === "JSXIdentifier" ? node.openingElement.name.name : "";

export default defineRule({
  meta: {
    type: "suggestion",
    docs: { description: "Avoid tooltips that repeat the trigger's visible text." },
  },
  create(context) {
    const source = context.sourceCode;
    const text = (node: ESTree.Node): string | null => {
      if (node.type === "JSXText") return node.value;
      if (node.type === "Literal" && typeof node.value === "string") return node.value;
      if (node.type === "JSXExpressionContainer") {
        if (node.expression.type === "JSXEmptyExpression") return "";
        return text(node.expression) ?? `{{${source.getText(node.expression)}}}`;
      }
      if (node.type === "ConditionalExpression") {
        const yes = text(node.consequent);
        const no = text(node.alternate);
        if (yes === "" && no === "") return "";
      }
      if (node.type !== "JSXElement" && node.type !== "JSXFragment") return null;
      if (node.type === "JSXElement") {
        const classes = node.openingElement.attributes.find(
          (attribute) =>
            attribute.type === "JSXAttribute" &&
            attribute.name.type === "JSXIdentifier" &&
            attribute.name.name === "className",
        );
        const opening = classes ? source.getText(classes) : "";
        if (
          node.openingElement.attributes.some(
            (attribute) =>
              attribute.type === "JSXAttribute" &&
              attribute.name.type === "JSXIdentifier" &&
              attribute.name.name === "aria-hidden" &&
              (!attribute.value ||
                (attribute.value.type === "Literal" && attribute.value.value === "true")),
          )
        )
          return "";
        if (/\b(?:truncate|line-clamp|text-ellipsis|sr-only|hidden)\b/u.test(opening)) return null;
        // Unknown components can supply visible content through props or their implementation.
        if (
          /^[A-Z]/u.test(name(node)) &&
          !["TooltipTrigger", "TooltipPopup", "Button"].includes(name(node))
        ) {
          return /(?:Icon|^svg$)/u.test(name(node)) && node.children.length === 0 ? "" : null;
        }
        if (name(node) === "svg") return "";
      }
      const render =
        node.type === "JSXElement"
          ? node.openingElement.attributes.find(
              (attribute) =>
                attribute.type === "JSXAttribute" &&
                attribute.name.type === "JSXIdentifier" &&
                attribute.name.name === "render",
            )
          : undefined;
      const rendered =
        render?.type === "JSXAttribute" &&
        render.value?.type === "JSXExpressionContainer" &&
        render.value.expression.type === "JSXElement"
          ? render.value.expression
          : null;
      const renderedText = rendered ? text(rendered) : "";
      if (renderedText === null) return null;
      const parts = [renderedText, ...node.children.map(text)];
      return parts.includes(null) ? null : parts.join("");
    };
    const normalize = (value: string) => value.replace(/\s+/gu, " ").trim();
    return {
      JSXElement(node) {
        if (name(node) !== "Tooltip") return;
        const elements = node.children.filter(
          (child): child is ESTree.JSXElement => child.type === "JSXElement",
        );
        const trigger = elements.find((child) => name(child) === "TooltipTrigger");
        const popup = elements.find((child) => name(child) === "TooltipPopup");
        if (!trigger || !popup) return;
        const label = text(trigger);
        const tip = text(popup);
        if (label && tip && normalize(label) && normalize(label) === normalize(tip)) {
          context.report({
            node: popup,
            message:
              "Tooltip repeats visible trigger text. Remove it unless it adds detail or reveals truncated text.",
          });
        }
      },
    };
  },
});
