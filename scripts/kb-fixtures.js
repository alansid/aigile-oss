// 知識庫測試用：用程式產生小的 .docx／.pptx／.xlsx（zip＋deflate，用內建 CompressionStream，不裝套件）
const enc = s => new TextEncoder().encode(s);
async function deflateRaw(bytes) {
  const cs = new CompressionStream('deflate-raw');
  const w = cs.writable.getWriter(); w.write(bytes); w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}
// entries：[[檔名, 文字]]；stored=true 不壓縮（測兩種方式都讀得到）
export async function makeZip(entries, { stored = false } = {}) {
  const parts = [], central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const n = enc(name), raw = typeof content === 'string' ? enc(content) : content;
    const data = stored ? raw : await deflateRaw(raw);
    const local = new Uint8Array(30 + n.length), v = new DataView(local.buffer);
    v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(8, stored ? 0 : 8, true);
    v.setUint32(18, data.length, true); v.setUint32(22, raw.length, true); v.setUint16(26, n.length, true);
    local.set(n, 30);
    const cd = new Uint8Array(46 + n.length), w = new DataView(cd.buffer);
    w.setUint32(0, 0x02014b50, true); w.setUint16(4, 20, true); w.setUint16(6, 20, true); w.setUint16(10, stored ? 0 : 8, true);
    w.setUint32(20, data.length, true); w.setUint32(24, raw.length, true); w.setUint16(28, n.length, true); w.setUint32(42, offset, true);
    cd.set(n, 46);
    parts.push(local, data); central.push(cd);
    offset += local.length + data.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = new Uint8Array(22), e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, entries.length, true); e.setUint16(10, entries.length, true); e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
  let p = 0; for (const a of all) { out.set(a, p); p += a.length; }
  return out;
}
const x = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const CT = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>';

// paras：[{ h: 1, text }] 標題、{ text } 內文、{ table: [[...], [...]] } 表格。標題用中文 Word 常見的數字 styleId（樣式名 heading N）
export function makeDocx(paras, opts) {
  const body = paras.map(p => p.table
    ? `<w:tbl><w:tblPr/>${p.table.map(r => `<w:tr>${r.map(c => `<w:tc><w:tcPr/><w:p><w:r><w:t>${x(c)}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`
    : `<w:p>${p.h ? `<w:pPr><w:pStyle w:val="${p.h}"/><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>` : ''}${String(p.text).split('\t').map((s, i) => `${i ? '<w:r><w:tab/></w:r>' : ''}<w:r><w:t xml:space="preserve">${x(s)}</w:t></w:r>`).join('')}</w:p>`).join('');
  const styles = `<w:styles>${[1, 2, 3].map(n => `<w:style w:type="paragraph" w:styleId="${n}"><w:name w:val="heading ${n}"/></w:style>`).join('')}</w:styles>`;
  return makeZip([['[Content_Types].xml', CT], ['word/document.xml', `<?xml version="1.0"?><w:document><w:body>${body}<w:sectPr/></w:body></w:document>`], ['word/styles.xml', styles]], opts);
}
// slides：[{ lines: [...], notes: [...] }]
export function makePptx(slides, opts) {
  const sp = lines => lines.map(l => `<a:p><a:r><a:t>${x(l)}</a:t></a:r></a:p>`).join('');
  const files = [['[Content_Types].xml', CT], ['ppt/presentation.xml', '<p:presentation/>']];
  slides.forEach((s, i) => {
    const n = i + 1;
    files.push([`ppt/slides/slide${n}.xml`, `<p:sld><p:cSld><p:spTree><p:sp><p:txBody>${sp(s.lines)}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`]);
    if (s.notes) {
      files.push([`ppt/slides/_rels/slide${n}.xml.rels`, `<Relationships><Relationship Id="rId2" Type="notesSlide" Target="../notesSlides/notesSlide${n}.xml"/></Relationships>`]);
      files.push([`ppt/notesSlides/notesSlide${n}.xml`, `<p:notes><p:txBody>${sp(s.notes)}<a:p><a:fld type="slidenum"><a:t>${n}</a:t></a:fld></a:p></p:txBody></p:notes>`]);
    }
  });
  return makeZip(files, opts);
}
// sheets：[{ name, rows: [[...]] }]；字串放 sharedStrings、數字直接放
export function makeXlsx(sheets, opts) {
  const shared = [], si = s => { let i = shared.indexOf(s); if (i < 0) { i = shared.length; shared.push(s); } return i; };
  const col = i => String.fromCharCode(65 + i);
  const files = [['[Content_Types].xml', CT],
    ['xl/workbook.xml', `<workbook><sheets>${sheets.map((s, i) => `<sheet name="${x(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<Relationships>${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`]];
  sheets.forEach((s, i) => files.push([`xl/worksheets/sheet${i + 1}.xml`, `<worksheet><sheetData>${s.rows.map((r, ri) => `<row r="${ri + 1}">${r.map((c, ci) => c === '' || c == null ? '' : typeof c === 'number'
    ? `<c r="${col(ci)}${ri + 1}"><v>${c}</v></c>` : `<c r="${col(ci)}${ri + 1}" t="s"><v>${si(c)}</v></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`]));
  files.push(['xl/sharedStrings.xml', `<sst>${shared.map(s => `<si><t>${x(s)}</t></si>`).join('')}</sst>`]);
  return makeZip(files, opts);
}
