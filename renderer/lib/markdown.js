// ── SYNTAX HIGHLIGHTER ─────────────────────────
function highlightCode(raw, lang) {
  const S = [];
  const save = h => { const i = S.length; S.push(h); return `\x01p${i}p\x01`; };
  const span = (cls, t) => save(`<span class="${cls}">${t}</span>`);

  let s = raw.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const L = (lang||'').toLowerCase();

  s = s.replace(/\/\*[\s\S]*?\*\//g,    m => span('tk-cmt', m));
  s = s.replace(/\/\/[^\n]*/g,          m => span('tk-cmt', m));
  if (!L || /^(py(thon)?|rb|ruby|bash|sh|ya?ml)$/.test(L))
    s = s.replace(/#[^\n]*/g,           m => span('tk-cmt', m));
  s = s.replace(/"(?:[^"\\]|\\.)*"/g,   m => span('tk-str', m));
  s = s.replace(/'(?:[^'\\]|\\.)*'/g,   m => span('tk-str', m));
  s = s.replace(/\b\d+\.?\d*\b/g,       m => span('tk-num', m));
  // Keywords
  const KW = {
    java:   /\b(abstract|assert|boolean|break|byte|case|catch|char|class|const|continue|default|do|double|else|enum|extends|final|finally|float|for|if|implements|import|instanceof|int|interface|long|native|new|null|package|private|protected|public|return|short|static|super|switch|synchronized|this|throw|throws|transient|try|var|void|volatile|while|true|false)\b/g,
    python: /\b(and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|None|nonlocal|not|or|pass|raise|return|True|False|try|while|with|yield)\b/g,
    cpp:    /\b(auto|bool|break|case|catch|class|const|continue|default|delete|do|double|else|enum|explicit|extern|false|float|for|if|inline|int|long|namespace|new|nullptr|private|protected|public|return|short|sizeof|static|struct|switch|template|this|throw|true|try|typedef|typename|union|unsigned|using|virtual|void|while)\b/g,
  };
  const kwRe = KW[L] || /\b(async|await|break|case|catch|class|const|continue|default|delete|do|else|export|extends|false|finally|for|from|function|if|import|in|instanceof|let|new|null|of|return|static|super|switch|this|throw|true|try|typeof|undefined|var|void|while|with|yield)\b/g;
  s = s.replace(kwRe,                   m => span('tk-kw', m));
  s = s.replace(/\b(String|Integer|Long|Double|Float|Boolean|Object|Map|List|Set|ArrayList|HashMap|Optional|Stream|int|float|double|long|bool|str|dict|tuple|list|void|None|any)\b/g,
                                         m => span('tk-type', m));
  s = s.replace(/\b[A-Z][a-zA-Z0-9]+\b/g, m => span('tk-cls', m));
  s = s.replace(/\b([a-z_]\w*)(?=\s*\()/g, m => span('tk-fn', m));
  return s.replace(/\x01p(\d+)p\x01/g, (_, i) => S[+i]);
}

// ── MARKDOWN RENDERER ──────────────────────────
function renderMarkdown(raw) {
  if (!raw) return '';

  const fenceCount = (raw.match(/```/g) || []).length;
  if (fenceCount % 2 !== 0) raw = raw + '\n```';

  const blocks = [];
  let s = raw.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const i = blocks.length;
    blocks.push({ lang, code: code.trimEnd() });
    return `\x00BLK${i}\x00`;
  });

  s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
  s = s.replace(/^### (.+)$/gm, '<h5>$1</h5>');
  s = s.replace(/^## (.+)$/gm,  '<h4>$1</h4>');
  s = s.replace(/^# (.+)$/gm,   '<h3>$1</h3>');
  s = s.replace(/^[-*+] (.+)$/gm, '<li>$1</li>');
  s = s.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  s = s.replace(/(<li>[\s\S]*?<\/li>\n?)+/g, m => `<ul>${m}</ul>`);

  const blkSegs = s.split(/(\x00BLK\d+\x00)/);
  s = blkSegs.map(seg => {
    if (/^\x00BLK\d+\x00$/.test(seg)) return seg; // code block — leave untouched
    return seg.split(/\n{2,}/).map(c => {
      c = c.trim();
      if (!c) return '';
      if (/^<(h[3-5]|ul|pre)/.test(c)) return c;
      return '<p>' + c.replace(/\n/g, '<br>') + '</p>';
    }).join('');
  }).join('');

  // Restore code blocks — skip expensive syntax highlight during streaming
  s = s.replace(/\x00BLK(\d+)\x00/g, (_, i) => {
    const { lang, code } = blocks[+i];
    const badge = lang ? `<span style="position:absolute;top:6px;right:10px;font-size:9px;color:#546e7a;font-family:var(--mono);letter-spacing:.1em;text-transform:uppercase">${lang}</span>` : '';
    return `<pre>${badge}<code>${highlightCode(code, lang)}</code></pre>`;
  });

  return s;
}

module.exports = { renderMarkdown, highlightCode };
