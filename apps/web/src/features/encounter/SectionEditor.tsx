import * as React from "react";
import type { SmartPhrase } from "@agile-emr/shared";
import { Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * One note section: plain text that grows with its content. Smart phrases expand when ".trigger" is followed by a
 * space or Enter. The caret position is reported so the toolbar can insert a phrase where the user was typing.
 */
export const SectionEditor = React.forwardRef<
  HTMLTextAreaElement,
  {
    id: string;
    label: string;
    value: string;
    onChange: (v: string) => void;
    phrases: SmartPhrase[];
    disabled?: boolean;
    placeholder?: string;
    testId?: string;
    onFocusSection?: () => void;
    className?: string;
  }
>(function SectionEditor(
  { id, label, value, onChange, phrases, disabled, placeholder, testId, onFocusSection, className },
  ref,
) {
  const local = React.useRef<HTMLTextAreaElement | null>(null);
  const setRef = (el: HTMLTextAreaElement | null) => {
    local.current = el;
    if (typeof ref === "function") ref(el);
    else if (ref) ref.current = el;
  };
  React.useLayoutEffect(() => {
    const el = local.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(56, el.scrollHeight + 2)}px`;
  }, [value]);

  const expand = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== " " && e.key !== "Enter") return;
    const el = e.currentTarget;
    const before = el.value.slice(0, el.selectionStart);
    const m = /(^|\s)\.([a-z0-9_-]+)$/i.exec(before);
    if (!m) return;
    const phrase = phrases.find((p) => p.trigger.toLowerCase() === m[2]!.toLowerCase());
    if (!phrase) return;
    e.preventDefault();
    const start = before.length - m[2]!.length - 1;
    const next =
      el.value.slice(0, start) +
      phrase.text +
      (e.key === "Enter" ? "\n" : " ") +
      el.value.slice(el.selectionEnd);
    onChange(next);
    const caret = start + phrase.text.length + 1;
    requestAnimationFrame(() => local.current?.setSelectionRange(caret, caret));
  };

  return (
    <Textarea
      ref={setRef}
      id={id}
      aria-label={label}
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={expand}
      onFocus={onFocusSection}
      data-testid={testId}
      className={cn("min-h-14 resize-none border-transparent hover:border-line-strong", className)}
    />
  );
});

/** Insert text at the caret of a textarea (smart phrase menu), returning the new value. */
export function insertAtCaret(el: HTMLTextAreaElement | null, value: string, text: string): string {
  if (!el) return value ? `${value}\n${text}` : text;
  const s = el.selectionStart ?? value.length;
  const e = el.selectionEnd ?? value.length;
  const pre = value.slice(0, s);
  const sep = pre && !/\s$/.test(pre) ? " " : "";
  return pre + sep + text + value.slice(e);
}
