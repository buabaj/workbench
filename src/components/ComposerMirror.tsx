/**
 * Colouring `@references` inside the composer.
 *
 * A textarea cannot style a range of its own text — it is one colour or none —
 * so the accepted trick is to stack two boxes: the real textarea with its text
 * made transparent, and behind it a div holding the same string with the
 * mentions wrapped. The caret, selection and every editing behaviour stay the
 * textarea's; only the pixels come from underneath.
 *
 * That only works while the two boxes lay text out identically, which is why
 * the mirror takes no styling of its own: font, padding, line-height and
 * wrapping all come from `.composer-input` in the stylesheet, and both elements
 * carry that class. Anything set here and not there would show up as a slow
 * drift between the glyphs you see and the caret you type with.
 */
export function ComposerMirror({ text, scrollTop }: { text: string; scrollTop: number }) {
  // The same shape `extractMentions` recognises and the transcript renders, so
  // a reference looks the same in the box you typed it in as it does in the
  // message you sent.
  const parts = text.split(/((?:^|\s)@[^\s]+)/g);
  return (
    <div className="composer-mirror composer-input" aria-hidden style={{ transform: `translateY(${-scrollTop}px)` }}>
      {parts.map((part, i) => {
        const m = /^(\s*)@([^\s]+)$/.exec(part);
        if (!m) return <span key={i}>{part}</span>;
        return (
          <span key={i}>
            {m[1]}
            <span className="composer-mention">@{m[2]}</span>
          </span>
        );
      })}
      {/* A trailing newline collapses without something after it, so the last
          line of the mirror would sit one line above the caret. */}
      {"​"}
    </div>
  );
}
