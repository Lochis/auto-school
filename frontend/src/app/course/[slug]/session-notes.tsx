import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronDownIcon, SparklesIcon } from "@heroicons/react/24/outline";
import { Eyebrow } from "@/components/ui";
import "../../sessions-ui.css";

/** Notes markdown rendered server-side, collapsed by default.
 *  Screen-2 chrome: "Class Notes" collapsible + "AI Structured Summary"
 *  eyebrow (structured section promotion happens client-side in LazyNotes). */
export default function SessionNotes({ markdown }: { markdown: string }) {
  return (
    <details className="sess-collapse sess-collapse--notes">
      <summary>
        <span className="sess-collapse-label">
          <ChevronDownIcon className="heroicon sess-chev" />
          Class Notes
        </span>
        <span className="sess-collapse-right">
          <Eyebrow tone="emerald"><SparklesIcon className="heroicon" /> AI Structured Summary</Eyebrow>
        </span>
      </summary>
      <div className="sess-collapse-body sess-notes-scope">
        <div className="notes">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
        </div>
      </div>
    </details>
  );
}
