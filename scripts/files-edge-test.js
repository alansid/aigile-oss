// files.js 邊界與異常案例獨立單元測試
// 涵蓋：cleanFileName、inspectFile、zipEntryNames、formatBytes、白名單、路徑穿越、控制字元、魔術位元組、大小限制、Office 巨集等

import assert from 'node:assert/strict';
import {
  cleanFileName,
  inspectFile,
  zipEntryNames,
  formatBytes,
  FileRejected,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  ALLOWED,
  ALLOWED_LIST,
} from '../src/files.js';

function test(name, fn) {
  try {
    fn();
  } catch (err) {
    console.error(`  [FAIL] ${name}`);
    console.error(err);
    process.exit(1);
  }
}

// 輔助函式：建立無壓縮的合規 zip 二進位資料
const enc = (s) => new TextEncoder().encode(s);
function makeZip(entries, mutateEocd) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const n = enc(name);
    const c = typeof content === 'string' ? enc(content) : content;
    const local = new Uint8Array(30 + n.length);
    const v = new DataView(local.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true);
    v.setUint32(18, c.length, true);
    v.setUint32(22, c.length, true);
    v.setUint16(26, n.length, true);
    local.set(n, 30);

    const cd = new Uint8Array(46 + n.length);
    const w = new DataView(cd.buffer);
    w.setUint32(0, 0x02014b50, true);
    w.setUint16(4, 20, true);
    w.setUint16(6, 20, true);
    w.setUint32(20, c.length, true);
    w.setUint32(24, c.length, true);
    w.setUint16(28, n.length, true);
    w.setUint32(42, offset, true);
    cd.set(n, 46);

    parts.push(local, c);
    central.push(cd);
    offset += local.length + c.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, entries.length, true);
  e.setUint16(10, entries.length, true);
  e.setUint32(12, cdSize, true);
  e.setUint32(16, offset, true);

  if (mutateEocd) {
    mutateEocd(e);
  }

  const all = [...parts, ...central, end];
  const total = all.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const item of all) {
    out.set(item, p);
    p += item.length;
  }
  return out;
}

// === 1. cleanFileName 邊界測試 ===

test('正常檔名保持不變', () => {
  assert.equal(cleanFileName('report.pdf'), 'report.pdf');
  assert.equal(cleanFileName('專案會議紀錄-2026.docx'), '專案會議紀錄-2026.docx');
});

test('Unix 路徑穿越與目錄分離', () => {
  assert.equal(cleanFileName('../../etc/passwd'), 'passwd');
  assert.equal(cleanFileName('/var/log/app/server.log.txt'), 'server.log.txt');
  assert.equal(cleanFileName('../../../secret.pdf'), 'secret.pdf');
});

test('Windows 路徑穿越與反斜線分離', () => {
  assert.equal(cleanFileName('..\\..\\windows\\system32\\calc.exe'), 'calc.exe');
  assert.equal(cleanFileName('C:\\Users\\user\\Desktop\\notes.md'), 'notes.md');
  assert.equal(cleanFileName('..\\..\\..\\flag.txt'), 'flag.txt');
});

test('混合斜線與多重斜線路徑', () => {
  assert.equal(cleanFileName('foo//bar\\\\baz/doc.pdf'), 'doc.pdf');
});

test('以斜線或反斜線結尾之空檔名', () => {
  assert.equal(cleanFileName('/var/log/'), '');
  assert.equal(cleanFileName('C:\\Windows\\'), '');
  assert.equal(cleanFileName('/'), '');
  assert.equal(cleanFileName('\\'), '');
});

test('ASCII 控制字元(\\u0000-\\u001f 及 \\u007f)與雙引號過濾', () => {
  assert.equal(cleanFileName('evil\x00file.png'), 'evilfile.png');
  assert.equal(cleanFileName('\x1b[31mcolor\x1b[0m.txt'), '[31mcolor[0m.txt');
  assert.equal(cleanFileName('tab\there\r\nline.docx'), 'tabhereline.docx');
  assert.equal(cleanFileName('delete\x7fchar.pdf'), 'deletechar.pdf');
  assert.equal(cleanFileName('"quoted_name".jpg'), 'quoted_name.jpg');
  assert.equal(cleanFileName('"""".png'), '.png');
});

test('長度超過 100 字元的主檔名截斷，保留副檔名', () => {
  const longName120 = 'a'.repeat(120);
  const cleaned = cleanFileName(`${longName120}.pdf`);
  assert.equal(cleaned, 'a'.repeat(100) + '.pdf');
  assert.equal(cleaned.length, 104);

  // 中文字元長度截斷
  const longChinese = '測'.repeat(150);
  const cleanedZh = cleanFileName(`${longChinese}.txt`);
  assert.equal(cleanedZh, '測'.repeat(100) + '.txt');
});

test('無副檔名或特殊點號檔名', () => {
  assert.equal(cleanFileName('noext'), 'noext');
  assert.equal(cleanFileName('a'.repeat(150)), 'a'.repeat(100));
  assert.equal(cleanFileName('.gitignore'), '.gitignore');
  assert.equal(cleanFileName('dotend.'), 'dotend.');
  assert.equal(cleanFileName('archive.tar.gz'), 'archive.tar.gz');
});

test('空值、未定義、純空白', () => {
  assert.equal(cleanFileName(''), '');
  assert.equal(cleanFileName(null), '');
  assert.equal(cleanFileName(undefined), '');
  assert.equal(cleanFileName('   '), '');
  assert.equal(cleanFileName('   \r\n\t  '), '');
});

// === 2. zipEntryNames 邊界測試 ===

test('非 zip 格式或過短資料回傳 null', () => {
  assert.equal(zipEntryNames(new Uint8Array([])), null);
  assert.equal(zipEntryNames(new Uint8Array([1, 2, 3])), null);
  assert.equal(zipEntryNames(enc('Not a zip file at all')), null);
  assert.equal(zipEntryNames(new Uint8Array(21)), null); // 小於 EOCD 最小長度 22
});

test('正常 zip 檔成功解析所有 entry 檔名', () => {
  const z = makeZip([
    ['[Content_Types].xml', '<Types/>'],
    ['word/document.xml', '<doc/>'],
    ['word/media/image1.png', 'fake png'],
  ]);
  const entries = zipEntryNames(z);
  assert.deepEqual(entries, ['[Content_Types].xml', 'word/document.xml', 'word/media/image1.png']);
});

test('損壞的中央目錄指標或 signature 異常回傳 null', () => {
  // 將中央目錄 offset 改到無效位置
  const zCorruptOffset = makeZip([['test.txt', 'hello']], (eView) => {
    eView.setUint32(16, 999999, true); // 指向 buffer 外
  });
  assert.equal(zipEntryNames(zCorruptOffset), null);

  // 將中央目錄 signature (0x02014b50) 破壞
  const z = makeZip([['test.txt', 'hello']]);
  const corruptedSig = new Uint8Array(z);
  // 找到 0x02014b50 並蓋掉
  for (let i = 0; i < corruptedSig.length - 4; i++) {
    if (corruptedSig[i] === 0x50 && corruptedSig[i + 1] === 0x4b && corruptedSig[i + 2] === 0x01 && corruptedSig[i + 3] === 0x02) {
      corruptedSig[i] = 0x00;
      break;
    }
  }
  assert.equal(zipEntryNames(corruptedSig), null);
});

// === 3. inspectFile - 基本驗證與限制測試 ===

test('副檔名白名單檢查 - 不在白名單內被拒絕 (415 FILE_TYPE_NOT_ALLOWED)', () => {
  const disallowed = ['script.exe', 'test.sh', 'app.js', 'auto.bat', 'index.php', 'archive.zip', 'audio.mp3', 'clip.mp4'];
  for (const name of disallowed) {
    assert.throws(
      () => inspectFile(name, enc('data')),
      (err) => {
        assert.ok(err instanceof FileRejected);
        assert.equal(err.status, 415);
        assert.equal(err.code, 'FILE_TYPE_NOT_ALLOWED');
        assert.ok(err.message.includes(ALLOWED_LIST));
        return true;
      }
    );
  }
});

test('無副檔名被拒絕 (415 FILE_TYPE_NOT_ALLOWED)', () => {
  assert.throws(
    () => inspectFile('justAFile', enc('data')),
    (err) => {
      assert.ok(err instanceof FileRejected);
      assert.equal(err.status, 415);
      assert.equal(err.code, 'FILE_TYPE_NOT_ALLOWED');
      assert.ok(err.message.includes('（無副檔名）'));
      return true;
    }
  );
});

test('副檔名大小寫不敏感', () => {
  const pdfBytes = enc('%PDF-1.4 minimal');
  const res = inspectFile('REPORT.PDF', pdfBytes);
  assert.equal(res.ext, 'pdf');
  assert.equal(res.mime, 'application/pdf');

  const txtBytes = enc('plain text');
  assert.equal(inspectFile('README.TXT', txtBytes).ext, 'txt');
  assert.equal(inspectFile('NOTES.MD', txtBytes).ext, 'md');
});

test('空檔案被拒絕 (400 INVALID_REQUEST)', () => {
  assert.throws(
    () => inspectFile('empty.pdf', new Uint8Array(0)),
    (err) => {
      assert.ok(err instanceof FileRejected);
      assert.equal(err.status, 400);
      assert.equal(err.code, 'INVALID_REQUEST');
      assert.ok(err.message.includes('檔案是空的'));
      return true;
    }
  );
});

test('檔案超過大小限制被拒絕 (413 FILE_TOO_LARGE)', () => {
  // 預設 MAX_FILE_BYTES (2 MB)
  const overDefault = new Uint8Array(MAX_FILE_BYTES + 1);
  assert.throws(
    () => inspectFile('large.pdf', overDefault),
    (err) => {
      assert.ok(err instanceof FileRejected);
      assert.equal(err.status, 413);
      assert.equal(err.code, 'FILE_TOO_LARGE');
      assert.ok(err.message.includes('2 MB 上限'));
      return true;
    }
  );

  // 自訂 maxBytes
  const customLimit = 100;
  const overCustom = new Uint8Array(101);
  assert.throws(
    () => inspectFile('large.txt', overCustom, customLimit),
    (err) => {
      assert.ok(err instanceof FileRejected);
      assert.equal(err.status, 413);
      assert.equal(err.code, 'FILE_TOO_LARGE');
      return true;
    }
  );

  // 剛好在上限值則不會觸發 FILE_TOO_LARGE (會進入後續內容檢查)
  const exactCustom = enc('a'.repeat(100));
  const res = inspectFile('exact.txt', exactCustom, 100);
  assert.equal(res.ext, 'txt');
});

// === 4. inspectFile - 各類型魔術位元組與簽章檢查 ===

test('PDF 檔頭檢查 - %PDF- (0x25, 0x50, 0x44, 0x46, 0x2d)', () => {
  const validPdf = enc('%PDF-1.7\n%obj...\n%%EOF');
  const validRes = inspectFile('doc.pdf', validPdf);
  assert.equal(validRes.mime, 'application/pdf');

  // 偽裝：文字檔副檔名改 .pdf
  assert.throws(
    () => inspectFile('fake.pdf', enc('This is just text')),
    (err) => {
      assert.ok(err instanceof FileRejected);
      assert.equal(err.status, 415);
      assert.equal(err.code, 'FILE_SIGNATURE_MISMATCH');
      return true;
    }
  );

  // 偽裝：只有前 4 bytes '%PDF' 缺少 '-'
  assert.throws(
    () => inspectFile('fake.pdf', enc('%PDF0.0')),
    (err) => {
      assert.equal(err.code, 'FILE_SIGNATURE_MISMATCH');
      return true;
    }
  );

  // 極短 buffer (< 5 bytes)
  assert.throws(
    () => inspectFile('tiny.pdf', enc('%PD')),
    (err) => {
      assert.equal(err.code, 'FILE_SIGNATURE_MISMATCH');
      return true;
    }
  );
});

test('PNG 檔頭檢查 - 89 50 4E 47 0D 0A 1A 0A', () => {
  const validPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
  const res = inspectFile('image.png', validPng);
  assert.equal(res.mime, 'image/png');

  // 偽裝：少最後一個 byte
  const invalidPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x00]);
  assert.throws(
    () => inspectFile('image.png', invalidPng),
    (err) => {
      assert.equal(err.code, 'FILE_SIGNATURE_MISMATCH');
      return true;
    }
  );

  // 偽裝：只有 4 bytes
  assert.throws(
    () => inspectFile('image.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
    (err) => {
      assert.equal(err.code, 'FILE_SIGNATURE_MISMATCH');
      return true;
    }
  );
});

test('JPG / JPEG 檔頭檢查 - FF D8 FF', () => {
  const validJpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  assert.equal(inspectFile('photo.jpg', validJpg).mime, 'image/jpeg');
  assert.equal(inspectFile('photo.jpeg', validJpg).mime, 'image/jpeg');

  // 偽裝：前兩 byte 像但第三 byte 不符
  const invalidJpg = new Uint8Array([0xff, 0xd8, 0x00, 0x00]);
  assert.throws(
    () => inspectFile('photo.jpg', invalidJpg),
    (err) => {
      assert.equal(err.code, 'FILE_SIGNATURE_MISMATCH');
      return true;
    }
  );

  // 短 buffer (< 3 bytes)
  assert.throws(
    () => inspectFile('photo.jpg', new Uint8Array([0xff, 0xd8])),
    (err) => {
      assert.equal(err.code, 'FILE_SIGNATURE_MISMATCH');
      return true;
    }
  );
});

test('TXT 與 MD 檢查 - NUL 字元拒絕、UTF-8 格式驗證', () => {
  const validTxt = enc('Hello world! 這是繁體中文測試內容。\nMarkdown: **bold**');
  assert.equal(inspectFile('note.txt', validTxt).mime, 'text/plain; charset=utf-8');
  assert.equal(inspectFile('readme.md', validTxt).mime, 'text/markdown; charset=utf-8');

  // 含有 NUL (0x00) 字元的二進位資料
  const binaryWithNul = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x57, 0x6f]);
  assert.throws(
    () => inspectFile('binary.txt', binaryWithNul),
    (err) => {
      assert.equal(err.code, 'FILE_SIGNATURE_MISMATCH');
      return true;
    }
  );

  // 非法 UTF-8 序列 (例如無效 byte 0xff)
  const invalidUtf8 = new Uint8Array([0x48, 0x65, 0xff, 0xfe, 0x57]);
  assert.throws(
    () => inspectFile('broken.md', invalidUtf8),
    (err) => {
      assert.equal(err.code, 'FILE_SIGNATURE_MISMATCH');
      assert.ok(err.message.includes('需為 UTF-8 純文字'));
      return true;
    }
  );
});

// === 5. inspectFile - Office 文件及巨集 (vbaProject) 檢查 ===

test('合法 docx 檢查通過', () => {
  const docx = makeZip([
    ['[Content_Types].xml', '<Types/>'],
    ['word/document.xml', '<w:document/>'],
  ]);
  const res = inspectFile('document.docx', docx);
  assert.equal(res.mime, ALLOWED.docx.mime);
});

test('合法 xlsx 檢查通過', () => {
  const xlsx = makeZip([
    ['[Content_Types].xml', '<Types/>'],
    ['xl/workbook.xml', '<workbook/>'],
  ]);
  const res = inspectFile('sheet.xlsx', xlsx);
  assert.equal(res.mime, ALLOWED.xlsx.mime);
});

test('合法 pptx 檢查通過', () => {
  const pptx = makeZip([
    ['[Content_Types].xml', '<Types/>'],
    ['ppt/presentation.xml', '<presentation/>'],
  ]);
  const res = inspectFile('slides.pptx', pptx);
  assert.equal(res.mime, ALLOWED.pptx.mime);
});

test('Office 檔案非 zip 檔頭 (PK 0x50 0x4B 0x03 0x04) 拒絕', () => {
  const fakeDocx = enc('Not a zip file header');
  assert.throws(
    () => inspectFile('doc.docx', fakeDocx),
    (err) => {
      assert.equal(err.code, 'FILE_SIGNATURE_MISMATCH');
      return true;
    }
  );
});

test('Office 檔案為 zip 但缺少 [Content_Types].xml 拒絕', () => {
  const missingContentTypes = makeZip([
    ['word/document.xml', '<w:document/>'],
  ]);
  assert.throws(
    () => inspectFile('test.docx', missingContentTypes),
    (err) => {
      assert.equal(err.code, 'FILE_SIGNATURE_MISMATCH');
      return true;
    }
  );
});

test('Office 檔案類型錯置 (例如 xlsx 的內部結構放 docx 副檔名) 拒絕', () => {
  // docx 應有 word/ 目錄，但裡面只有 xl/
  const docxWithXl = makeZip([
    ['[Content_Types].xml', '<Types/>'],
    ['xl/workbook.xml', '<workbook/>'],
  ]);
  assert.throws(
    () => inspectFile('mismatch.docx', docxWithXl),
    (err) => {
      assert.equal(err.code, 'FILE_SIGNATURE_MISMATCH');
      return true;
    }
  );

  // pptx 應有 ppt/ 目錄，但裡面只有 word/
  const pptxWithWord = makeZip([
    ['[Content_Types].xml', '<Types/>'],
    ['word/document.xml', '<doc/>'],
  ]);
  assert.throws(
    () => inspectFile('mismatch.pptx', pptxWithWord),
    (err) => {
      assert.equal(err.code, 'FILE_SIGNATURE_MISMATCH');
      return true;
    }
  );
});

test('Office 巨集檔案 (含 vbaProject) 被嚴格拒絕 (415 OFFICE_MACRO_NOT_ALLOWED)', () => {
  // 小寫 vbaProject
  const macroDocx = makeZip([
    ['[Content_Types].xml', '<Types/>'],
    ['word/document.xml', '<w:document/>'],
    ['word/vbaProject.bin', 'macro binary'],
  ]);
  assert.throws(
    () => inspectFile('infected.docx', macroDocx),
    (err) => {
      assert.ok(err instanceof FileRejected);
      assert.equal(err.status, 415);
      assert.equal(err.code, 'OFFICE_MACRO_NOT_ALLOWED');
      assert.ok(err.message.includes('檔案含巨集（vbaProject）'));
      return true;
    }
  );

  // 大寫/混合大小寫 VBAproject
  const macroXlsx = makeZip([
    ['[Content_Types].xml', '<Types/>'],
    ['xl/workbook.xml', '<workbook/>'],
    ['xl/VBAPROJECT.BIN', 'macro binary'],
  ]);
  assert.throws(
    () => inspectFile('macro.xlsx', macroXlsx),
    (err) => {
      assert.equal(err.code, 'OFFICE_MACRO_NOT_ALLOWED');
      return true;
    }
  );

  // pptx 巨集
  const macroPptx = makeZip([
    ['[Content_Types].xml', '<Types/>'],
    ['ppt/presentation.xml', '<presentation/>'],
    ['ppt/vbaProject.bin', 'macro binary'],
  ]);
  assert.throws(
    () => inspectFile('macro.pptx', macroPptx),
    (err) => {
      assert.equal(err.code, 'OFFICE_MACRO_NOT_ALLOWED');
      return true;
    }
  );
});

// === 6. formatBytes 邊界測試 ===

test('位元組格式化邊界值', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(1048575), '1024.0 KB');
  assert.equal(formatBytes(1048576), '1.0 MB');
  assert.equal(formatBytes(1048576 * 2.5), '2.5 MB');
  assert.equal(formatBytes(1073741823), '1024.0 MB');
  assert.equal(formatBytes(1073741824), '1.0 GB');
  assert.equal(formatBytes(MAX_TOTAL_BYTES), '4.0 GB');
});

console.log('files-edge-test：全部通過');
