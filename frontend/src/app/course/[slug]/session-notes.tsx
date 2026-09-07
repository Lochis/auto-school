import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Notes markdown rendered server-side, collapsed by default. */
export default function SessionNotes({ markdown }: { markdown: string }) {
  return (
    <details style={{ marginTop: 10 }}>
      <summary>Notes</summary>
      <div className="notes">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
      </div>
    </details>
  );
}
