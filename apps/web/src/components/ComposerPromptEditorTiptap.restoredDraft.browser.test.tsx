import { CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS } from "@t3tools/shared/markdownPipeline";
import { createRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";

import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";

const draft =
  "A sample note.\n\n> The preview uses `.sample` data.\nThread reference: sample-thread";

function Composer({ restoredOnMount = true, richTextEnabled = true, literalText = false }) {
  const [value, setValue] = useState(restoredOnMount ? draft : "");
  const [sent, setSent] = useState("");
  return (
    <>
      <ComposerPromptEditor
        editorRef={createRef<ComposerPromptEditorHandle>()}
        value={value}
        cursor={0}
        richTextEnabled={richTextEnabled}
        literalText={literalText}
        contextRecords={new Map()}
        skills={[]}
        disabled={false}
        placeholder=""
        onChange={setValue}
        onPaste={() => {}}
      />
      <button onClick={() => setValue(draft)}>Restore draft</button>
      <button onClick={() => setSent(value)}>Send</button>
      <output>{value}</output>
      <article>
        <ReactMarkdown remarkPlugins={CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS}>
          {sent}
        </ReactMarkdown>
      </article>
    </>
  );
}

it.each([true, false])(
  "sends the displayed quote boundary without an edit (restored on mount: %s)",
  async (restoredOnMount) => {
    await using screen = await render(<Composer restoredOnMount={restoredOnMount} />);
    const { container } = screen;
    if (!restoredOnMount) {
      await userEvent.click(container.querySelectorAll("button")[0]!);
    }
    expect(container.querySelector(".tiptap blockquote")?.textContent).toBe(
      "The preview uses .sample data.",
    );
    await userEvent.click(container.querySelectorAll("button")[1]!);
    const message = container.querySelector("article")!;
    expect(message.querySelector("blockquote")?.textContent?.trim()).toBe(
      "The preview uses .sample data.",
    );
    expect(message.querySelector("blockquote code")?.textContent).toBe(".sample");
    expect(message.querySelector(":scope > p:last-child")?.textContent).toBe(
      "Thread reference: sample-thread",
    );
  },
);

it.each([{ richTextEnabled: false }, { literalText: true }])(
  "preserves literal input for %j",
  async (props) => {
    await using screen = await render(<Composer {...props} />);
    expect(screen.container.querySelector("output")?.textContent).toBe(draft);
  },
);
