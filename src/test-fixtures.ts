// 測試用的合成 PDF（不進 Cloud Run 的流程；engine.test.ts 與 fixtures/ 的檔案用）。
// 工單 67：漸層網格（mesh shading，ShadingType 4–7）＋壞掉的 shading＋文字。
//   第 1 頁：標題與內文；四個正常的網格 shading（type 4 三角網格、5 格狀、6 Coons patch、7 tensor patch，用 sh 畫）、
//            一個 shading pattern 的填色（type 6，用 scn＋f 畫）、一個線性漸層（type 2）；
//            四個壞掉的 shading：ShadingType 97、115（和 Cloud Run 的錯誤訊息同一個數字）、資料被截斷的 type 4、BitsPerFlag 3 的 type 6。
//   第 2 頁：只有文字。
// 手寫 PDF 物件（mupdf 的 DocumentWriter 寫不出 sh 與壞掉的 shading）。

/** 第 1 頁的文字（測試用來確認「其他內容照畫」） */
export const SHADING_PDF_TEXT = ['Mesh shading test', 'Text next to broken gradients still renders.'] as const;

/** 位元組（0–255）陣列 → PDF 的 binary 字串（latin1） */
function bytes(values: readonly number[]): string {
  return String.fromCharCode(...values);
}

/** 正方形 0–100 的外框上 12 個控制點（Coons patch 的順序），座標在 Decode [0 255 0 255] 底下就是 pt */
const PATCH_EDGE = [0, 0, 0, 33, 0, 66, 0, 100, 33, 100, 66, 100, 100, 100, 100, 66, 100, 33, 100, 0, 66, 0, 33, 0];
const PATCH_INNER = [33, 33, 33, 66, 66, 66, 66, 33];
const PATCH_COLORS = [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0];
const MESH = '/ColorSpace /DeviceRGB /BitsPerCoordinate 8 /BitsPerComponent 8 /BitsPerFlag 8 /Decode [0 255 0 255 0 1 0 1 0 1]';

export function buildShadingPdf(): Uint8Array {
  const shadings: Record<string, { dict: string; data?: string }> = {
    // 正常的網格
    Sh4: { dict: `/ShadingType 4 ${MESH}`, data: bytes([0, 0, 0, 255, 0, 0, 0, 100, 0, 0, 255, 0, 0, 50, 100, 0, 0, 255]) },
    Sh5: {
      dict: `/ShadingType 5 ${MESH.replace('/BitsPerFlag 8 ', '')} /VerticesPerRow 2`,
      data: bytes([0, 0, 255, 0, 0, 100, 0, 0, 255, 0, 0, 100, 0, 0, 255, 100, 100, 255, 255, 0]),
    },
    Sh6: { dict: `/ShadingType 6 ${MESH}`, data: bytes([0, ...PATCH_EDGE, ...PATCH_COLORS]) },
    Sh7: { dict: `/ShadingType 7 ${MESH}`, data: bytes([0, ...PATCH_EDGE, ...PATCH_INNER, ...PATCH_COLORS]) },
    Sh2: { dict: '/ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 100 0] /Function << /FunctionType 2 /Domain [0 1] /C0 [1 1 0] /C1 [0 1 1] /N 1 >>' },
    // 壞掉的 shading
    Bad97: { dict: `/ShadingType 97 ${MESH}`, data: bytes([0, 0, 0, 255, 0, 0]) },
    Bad115: { dict: `/ShadingType 115 ${MESH}`, data: bytes([0, 0, 0, 255, 0, 0]) },
    BadTruncated: { dict: `/ShadingType 4 ${MESH}`, data: bytes([0, 0, 0, 255]) },
    BadFlag: { dict: `/ShadingType 6 ${MESH.replace('/BitsPerFlag 8', '/BitsPerFlag 3')}`, data: bytes([0, ...PATCH_EDGE.slice(0, 10)]) },
  };
  const names = Object.keys(shadings);
  const place = (name: string, x: number, y: number) => `q 1 0 0 1 ${String(x)} ${String(y)} cm 0 0 100 100 re W n /${name} sh Q`;
  const content1 = [
    `BT /F1 20 Tf 72 720 Td (${SHADING_PDF_TEXT[0]}) Tj ET`,
    place('Sh4', 72, 560),
    place('Bad97', 200, 560),
    place('Sh5', 200, 560),
    place('Sh6', 328, 560),
    place('Bad115', 456, 560),
    place('Sh7', 456, 560),
    place('BadTruncated', 72, 420),
    place('BadFlag', 200, 420),
    place('Sh2', 328, 420),
    // shading pattern 的填色
    '/Pattern cs /P1 scn 456 420 100 100 re f',
    `BT /F1 12 Tf 72 380 Td (${SHADING_PDF_TEXT[1]}) Tj ET`,
  ].join('\n');
  const content2 = 'BT /F1 12 Tf 72 720 Td (Second page: text only.) Tj ET';
  // 物件編號：1 Catalog、2 Pages、3–4 兩頁、5 字型、6–7 內容、8 pattern、9 起是 shading
  const shadingRefs = names.map((name, i) => `/${name} ${String(9 + i)} 0 R`).join(' ');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> /Shading << ${shadingRefs} >> /Pattern << /P1 8 0 R >> >> /Contents 6 0 R >>`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${String(content1.length)} >>\nstream\n${content1}\nendstream`,
    `<< /Length ${String(content2.length)} >>\nstream\n${content2}\nendstream`,
    `<< /PatternType 2 /Shading ${String(9 + names.indexOf('Sh6'))} 0 R /Matrix [1 0 0 1 456 420] >>`,
    ...names.map((name) => {
      const { dict, data } = shadings[name] ?? { dict: '' };
      return data === undefined ? `<< ${dict} >>` : `<< ${dict} /Length ${String(data.length)} >>\nstream\n${data}\nendstream`;
    }),
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${String(i + 1)} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  const entries = offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n${entries}`;
  out += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return Uint8Array.from(out, (c) => c.charCodeAt(0));
}
