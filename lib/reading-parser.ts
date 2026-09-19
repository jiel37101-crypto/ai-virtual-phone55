// lib/reading-parser.ts — File parsing for TXT, EPUB, PDF.

// ── PDF.js CDN loader ──
const PDFJS_VERSION = "3.11.174"; // stable version available on cdnjs
const PDFJS_CDN = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}`;
let _pdfjsPromise: Promise<any> | null = null;

function loadPdfjs(): Promise<any> {
    if (_pdfjsPromise) return _pdfjsPromise;
    _pdfjsPromise = new Promise((resolve, reject) => {
        if ((window as any).pdfjsLib) { resolve((window as any).pdfjsLib); return; }
        const script = document.createElement("script");
        script.src = `${PDFJS_CDN}/pdf.min.mjs`;
        script.type = "module";
        // pdf.min.mjs is ESM, use a different approach — load the UMD build
        script.src = `${PDFJS_CDN}/pdf.min.js`;
        script.type = "text/javascript";
        script.onload = () => {
            const lib = (window as any).pdfjsLib;
            if (lib) {
                lib.GlobalWorkerOptions.workerSrc = `${PDFJS_CDN}/pdf.worker.min.js`;
                resolve(lib);
            } else {
                reject(new Error("pdfjsLib not found after script load"));
            }
        };
        script.onerror = () => reject(new Error("Failed to load PDF.js from CDN"));
        document.head.appendChild(script);
    });
    return _pdfjsPromise;
}

type PdfSource = ArrayBuffer | Blob;

export type ParsedChapter = {
    title: string;
    paragraphs: string[];
};

export type ParsedBook = {
    title: string;
    author?: string;
    chapters: ParsedChapter[];
};

export type TxtDecodeResult = {
    text: string;
    encoding: string;
};

const TXT_DECODER_CANDIDATES = ["utf-8", "gb18030", "gbk", "big5", "utf-16le", "utf-16be"];

function decodeWithEncoding(buffer: ArrayBuffer, encoding: string): string | null {
    try {
        return new TextDecoder(encoding, { fatal: false }).decode(buffer).replace(/^\uFEFF/, "");
    } catch {
        return null;
    }
}

function scoreDecodedTxt(text: string): number {
    const sample = text.slice(0, 24000);
    if (!sample.trim()) return -100000;

    const replacementCount = (sample.match(/\uFFFD/g) || []).length;
    const nulCount = (sample.match(/\u0000/g) || []).length;
    const controlCount = (sample.match(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g) || []).length;
    const cjkCount = (sample.match(/[\u3400-\u9FFF\uF900-\uFAFF]/g) || []).length;
    const punctuationCount = (sample.match(/[，。！？；：“”‘’、（）《》…]/g) || []).length;
    const readableCount = (sample.match(/[A-Za-z0-9\s]/g) || []).length;

    return cjkCount * 3
        + punctuationCount * 2
        + readableCount * 0.15
        - replacementCount * 80
        - nulCount * 100
        - controlCount * 20;
}

/**
 * 解码 TXT 字节流为文本。
 * @param preferredEncoding 用户手动指定的编码（auto 或 undefined = 自动探测）。
 *   指定时优先用该编码解码（BOM 仍优先，因为 BOM 是权威的）；用于用户遇到自动探测
 *   误判导致的乱码时，手动指定 TXT 的真实编码重新导入。
 */
export function decodeTxtArrayBuffer(buffer: ArrayBuffer, preferredEncoding?: string): TxtDecodeResult {
    const bytes = new Uint8Array(buffer);
    const bomCandidates: Array<[string, boolean]> = [];

    if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
        bomCandidates.push(["utf-8", true]);
    } else if (bytes[0] === 0xFF && bytes[1] === 0xFE) {
        bomCandidates.push(["utf-16le", true]);
    } else if (bytes[0] === 0xFE && bytes[1] === 0xFF) {
        bomCandidates.push(["utf-16be", true]);
    }

    // BOM 优先：有 BOM 就以 BOM 声明的编码为准（BOM 比手选更权威）
    for (const [encoding] of bomCandidates) {
        const text = decodeWithEncoding(buffer, encoding);
        if (text !== null) return { text, encoding };
    }

    // 用户手动指定了编码：直接用指定编码解码，不再自动探测
    if (preferredEncoding && preferredEncoding !== "auto") {
        const text = decodeWithEncoding(buffer, preferredEncoding);
        if (text !== null) return { text, encoding: preferredEncoding };
        return { text: "", encoding: preferredEncoding };
    }

    let best: TxtDecodeResult | null = null;
    let bestScore = -Infinity;

    for (const encoding of TXT_DECODER_CANDIDATES) {
        const text = decodeWithEncoding(buffer, encoding);
        if (text === null) continue;
        const score = scoreDecodedTxt(text);
        if (score > bestScore) {
            bestScore = score;
            best = { text, encoding };
        }
    }

    return best ?? { text: decodeWithEncoding(buffer, "utf-8") ?? "", encoding: "utf-8" };
}

// ── Chapter heading patterns ──
const CHAPTER_PATTERNS = [
    /^第[零一二三四五六七八九十百千\d]+[章节回卷集篇]/,       // 第X章, 第X节, 第X回...
    /^Chapter\s+\d+/i,                                        // Chapter 1
    /^CHAPTER\s+[IVXLCDM\d]+/,                                // CHAPTER IV
    /^卷[零一二三四五六七八九十百千\d]+/,                       // 卷一
    /^={3,}/,                                                  // ===
    /^-{3,}/,                                                  // ---
    /^#{1,3}\s+/,                                              // Markdown # heading
];

function isChapterHeading(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > 60) return false;
    return CHAPTER_PATTERNS.some(p => p.test(trimmed));
}

/** 剥离开头/结尾的空行：下载 TXT 常在章节标题前后插入分隔空行，
 *  它们不是作者段落空行，混入会污染 splitParagraphs 的空行占比检测。 */
function trimBlankEdges(arr: string[]): string[] {
    let s = 0;
    let e = arr.length;
    while (s < e && arr[s].trim() === "") s += 1;
    while (e > s && arr[e - 1].trim() === "") e -= 1;
    return arr.slice(s, e);
}

/**
 * Parse TXT content into chapters and paragraphs.
 * Splits by chapter headings, then by blank lines for paragraphs.
 * @param mode 段落划分方式：auto 自动探测 / blank 空行 / indent 段首缩进 / line 每行一段
 */
export function parseTxtContent(text: string, fileName?: string, mode: TxtParagraphMode = "auto"): ParsedBook {
    const lines = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

    // auto 模式：对整本书探测一次段落格式，所有章节共用同一结论，
    // 避免短章节里夹杂的空白行让个别章节误判成别的格式。
    const resolvedMode = mode === "auto" ? detectParagraphMode(lines) : mode;

    // First pass: find chapter boundaries
    const chapterStarts: { lineIdx: number; title: string }[] = [];
    for (let i = 0; i < lines.length; i++) {
        if (isChapterHeading(lines[i])) {
            chapterStarts.push({ lineIdx: i, title: lines[i].trim().replace(/^#{1,3}\s+/, "") });
        }
    }

    // Extract title from first non-empty line (if before first chapter)
    let bookTitle = fileName?.replace(/\.[^.]+$/, "") || "未命名";
    if (chapterStarts.length > 0 && chapterStarts[0].lineIdx > 0) {
        for (let i = 0; i < chapterStarts[0].lineIdx; i++) {
            if (lines[i].trim()) { bookTitle = lines[i].trim(); break; }
        }
    }

    // No chapters found → entire text is one chapter
    if (chapterStarts.length === 0) {
        return {
            title: bookTitle,
            chapters: [{
                title: "全文",
                paragraphs: splitParagraphs(trimBlankEdges(lines), resolvedMode),
            }],
        };
    }

    // Build chapters
    const chapters: ParsedChapter[] = [];
    for (let i = 0; i < chapterStarts.length; i++) {
        const start = chapterStarts[i].lineIdx + 1; // skip heading line
        const end = i + 1 < chapterStarts.length ? chapterStarts[i + 1].lineIdx : lines.length;
        const chapterLines = trimBlankEdges(lines.slice(start, end));
        const paragraphs = splitParagraphs(chapterLines, resolvedMode);
        if (paragraphs.length > 0) {
            chapters.push({ title: chapterStarts[i].title, paragraphs });
        }
    }

    // If there's content before the first chapter, add it as a prologue
    if (chapterStarts[0].lineIdx > 1) {
        const prologueLines = trimBlankEdges(lines.slice(0, chapterStarts[0].lineIdx));
        const paragraphs = splitParagraphs(prologueLines, resolvedMode);
        if (paragraphs.length > 0) {
            chapters.unshift({ title: "序", paragraphs });
        }
    }

    return { title: bookTitle, chapters };
}

/** 判断一行是否以缩进开头（全角空格 / 2+ 半角空格 / Tab）→ 视为新段落起点。
 *  很多中文网文 TXT 段落之间没有空行，仅靠段首缩进区分段落；
 *  若只按空行分割会把整章合并成一段（批注/讨论时整章一起发给模型）。
 */
function isIndentedParagraphStart(line: string): boolean {
    return /^\u3000/.test(line)   // 全角空格缩进（中文网文最常见）
        || /^ {2,}/.test(line)    // 2+ 半角空格缩进
        || /^\t/.test(line);      // Tab 缩进
}

/** 松散标题行检测：比 isChapterHeading 更宽泛，仅用于识别「章节分隔空行」。
 *  下载 TXT 常在章节标题前后插入分隔空行，这些不是作者段落空行，
 *  若混进空行占比会污染 splitParagraphs 的格式探测（章节很多但每章很短的小说
 *  空行占比轻松超过 2%，被误判成空行分段 → 整章变成一段）。 */
const LENIENT_TITLE_PATTERNS = [
    /^第[零一二三四五六七八九十百千\d]+[章节回卷集部篇]/,   // 第X章/节/回/卷/部/篇
    /^[序楔]/,                                            // 序章 / 楔子
    /^(?:终章|后记|前言|番外|尾声|外传|引子)/,            // 常见非数字标题
    /^[Cc]hapter\s+\d+/,
    /^[Pp]art\s+[IVXLCDM\d]+/,
    /^[零一二三四五六七八九十百千\d]+[、.．:：]/,           // 一、 / 1、 / 1.
    /^[（(][零一二三四五六七八九十百千\d]+[)）]/,           // （一）/（1）
    /^《.+》$/,                                            // 《书名》式短行
    /^[=#*\-]{3,}$/,                                      // 分隔线
];

function isTitleLikeLine(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > 40) return false;
    return LENIENT_TITLE_PATTERNS.some((p) => p.test(trimmed));
}

/** 统计「作者段落空行」数量：连续空行块紧邻标题行（前或后）的视为章节分隔空行，不计数 */
function countAuthorBlankLines(lines: string[]): number {
    const titleLike = new Set<number>();
    lines.forEach((line, i) => {
        if (isTitleLikeLine(line)) titleLike.add(i);
    });

    const isBlank = (i: number) => i >= 0 && i < lines.length && lines[i].trim() === "";
    let count = 0;
    let i = 0;
    while (i < lines.length) {
        if (!isBlank(i)) { i += 1; continue; }
        const runStart = i;
        while (i < lines.length && isBlank(i)) i += 1;
        const runEnd = i - 1;
        const beforeTitle = runStart > 0 && titleLike.has(runStart - 1);
        const afterTitle = runEnd + 1 < lines.length && titleLike.has(runEnd + 1);
        if (!beforeTitle && !afterTitle) count += runEnd - runStart + 1;
    }
    return count;
}

/** 按空行分段（标准网文导出格式；段内多行保持在同一段） */
function splitByBlankLines(lines: string[]): string[] {
    const paragraphs: string[] = [];
    let current: string[] = [];

    for (const line of lines) {
        if (line.trim() === "") {
            if (current.length > 0) {
                paragraphs.push(current.join("\n").trim());
                current = [];
            }
        } else {
            current.push(line);
        }
    }
    if (current.length > 0) {
        paragraphs.push(current.join("\n").trim());
    }

    return paragraphs.filter(p => p.length > 0);
}

/** 按段首缩进分段（无空行的中文网文 TXT） */
function splitByIndent(lines: string[]): string[] {
    const paragraphs: string[] = [];
    let current: string[] = [];

    const flush = () => {
        if (current.length > 0) {
            paragraphs.push(current.join("\n").trim());
            current = [];
        }
    };

    for (const line of lines) {
        if (line.trim() === "") {
            flush();
        } else if (isIndentedParagraphStart(line)) {
            flush();
            current.push(line);
        } else {
            current.push(line);
        }
    }
    flush();

    return paragraphs.filter(p => p.length > 0);
}

/** 智能分段：先探测本书格式再选策略——
 *  1) 空行占比 ≥ 15%：空行分段（标准导出格式，段内多行保留）
 *  2) 缩进行占比 ≥ 20%：段首缩进分段（晋江/起点手排 TXT，无空行）
 *  3) 空行占比 ≥ 2%：空行分段（段内多行较长、空行稀疏的情况）
 *  4) 否则：纯换行格式，一行一段（很多网文连开头缩进都省了，纯靠回车换行分段落）
 *  空行占比统计时已剔除「章节分隔空行」（紧邻标题行的空行块），
 *  避免下载 TXT 在章节间插入的空行污染探测。
 *  mode 参数可强制指定划分方式（auto=自动探测）。 */
export type TxtParagraphMode = "auto" | "blank" | "indent" | "line";

/** 全局探测一本书的段落格式（对整本书的 lines 调用一次，保证各章节结论一致） */
export function detectParagraphMode(lines: string[]): TxtParagraphMode {
    const nonEmpty = lines.filter((l) => l.trim() !== "");
    if (nonEmpty.length === 0) return "line";

    const blankRatio = countAuthorBlankLines(lines) / Math.max(1, lines.length);
    const indentedRatio = nonEmpty.filter(isIndentedParagraphStart).length / nonEmpty.length;

    if (blankRatio >= 0.15) return "blank";
    if (indentedRatio >= 0.2) return "indent";
    if (blankRatio >= 0.02) return "blank";
    return "line";
}

function splitParagraphs(lines: string[], mode: TxtParagraphMode = "auto"): string[] {
    const nonEmpty = lines.filter(l => l.trim() !== "");
    if (nonEmpty.length === 0) return [];

    if (mode === "blank") return splitByBlankLines(lines);
    if (mode === "indent") return splitByIndent(lines);
    if (mode === "line") return nonEmpty.map(l => l.trim()).filter(p => p.length > 0);

    const detected = detectParagraphMode(lines);
    if (detected === "blank") return splitByBlankLines(lines);
    if (detected === "indent") return splitByIndent(lines);
    return nonEmpty.map(l => l.trim()).filter(p => p.length > 0);
}

// ── EPUB Parsing ──

/** 在 ZIP 中查找并读取文本文件：精确路径 → URL 解码 → 大小写不敏感兜底。
 *  部分排版工具产出的 EPUB 里 OPF 的 href 与 ZIP 条目名在大小写/编码上不一致，
 *  原来直接 zip.file(path) 查不到就静默丢章节，这里做兜底。 */
async function readZipText(zip: any, path: string): Promise<string | null> {
    const candidates = new Set<string>();
    const push = (value: string) => { if (value) candidates.add(value); };
    push(path);
    try { push(decodeURIComponent(path)); } catch { /* 非法转义，保留原样 */ }

    for (const candidate of candidates) {
        const file = zip.file(candidate);
        if (file) return (await file.async("text")) as string;
    }

    // 大小写不敏感兜底（ZIP 条目名与 OPF href 大小写不一致的书）
    const lowerToReal = new Map<string, string>();
    for (const key of Object.keys(zip.files || {})) {
        const entry = zip.files[key];
        if (!entry || entry.dir) continue;
        const lower = key.toLowerCase();
        if (!lowerToReal.has(lower)) lowerToReal.set(lower, key);
    }
    for (const candidate of candidates) {
        const hit = lowerToReal.get(candidate.toLowerCase());
        if (hit) {
            const file = zip.file(hit);
            if (file) return (await file.async("text")) as string;
        }
    }
    return null;
}

/** 规整 ZIP 内路径：剥掉锚点/查询串，并按基准目录解析 ./ 与 ../。
 *  原来只做 rootDir + href 拼接，遇到 "../Text/ch1.xhtml" 这类引用会取不到文件。 */
function resolveZipPath(baseDir: string, href: string): string {
    const cleaned = href.split("#")[0].split("?")[0];
    let decoded = cleaned;
    try { decoded = decodeURIComponent(cleaned); } catch { /* 保留原样 */ }

    const raw = decoded.startsWith("/") ? decoded.slice(1) : baseDir + decoded;
    const out: string[] = [];
    for (const segment of raw.split("/")) {
        if (!segment || segment === ".") continue;
        if (segment === "..") { out.pop(); continue; }
        out.push(segment);
    }
    return out.join("/");
}

/** 取标签属性值，单双引号都认 */
function attrValue(tag: string, name: string): string {
    const match = tag.match(new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
    return (match?.[1] ?? match?.[2] ?? "").trim();
}

/** 解析 OPF manifest 的 id → href 映射：逐个 <item> 分别取属性，
 *  不再依赖 id 与 href 的书写顺序或引号类型（原正则要求 id 在 href 前且双引号，
 *  遇到 href 在前/单引号的 OPF 会整个映射为空，导致全书 0 章节）。 */
function parseManifestItems(manifestXml: string): Map<string, string> {
    const idToHref = new Map<string, string>();
    const itemPattern = /<item\b[^>]*\/?>/gi;
    let match: RegExpExecArray | null;
    while ((match = itemPattern.exec(manifestXml)) !== null) {
        const id = attrValue(match[0], "id");
        const href = attrValue(match[0], "href");
        if (id && href) idToHref.set(id, href);
    }
    if (idToHref.size === 0) {
        // 畸形 XML（标签没闭合干净）兜底：两种属性顺序都试
        const loosePatterns: Array<[RegExp, number, number]> = [
            [/id\s*=\s*["']([^"']+)["'][^>]*?href\s*=\s*["']([^"']+)["']/gi, 1, 2],
            [/href\s*=\s*["']([^"']+)["'][^>]*?id\s*=\s*["']([^"']+)["']/gi, 2, 1],
        ];
        for (const [pattern, idIndex, hrefIndex] of loosePatterns) {
            let lm: RegExpExecArray | null;
            while ((lm = pattern.exec(manifestXml)) !== null) {
                const id = lm[idIndex];
                const href = lm[hrefIndex];
                if (id && href && !idToHref.has(id)) idToHref.set(id, href);
            }
        }
    }
    return idToHref;
}

/**
 * Parse EPUB file into chapters and paragraphs.
 * EPUB is a ZIP containing XHTML files.
 */
export async function parseEpubFile(arrayBuffer: ArrayBuffer, fileName?: string): Promise<ParsedBook> {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(arrayBuffer);

    // 1. container.xml → rootfile 路径（可能有多个 rootfile，取第一个读得到的）
    const containerXml = await readZipText(zip, "META-INF/container.xml");
    if (!containerXml) throw new Error("Invalid EPUB: missing container.xml");
    const rootfilePaths: string[] = [];
    const rootfilePattern = /<rootfile\b[^>]*\/?>/gi;
    let rootfileMatch: RegExpExecArray | null;
    while ((rootfileMatch = rootfilePattern.exec(containerXml)) !== null) {
        const fullPath = attrValue(rootfileMatch[0], "full-path");
        if (fullPath) rootfilePaths.push(fullPath);
    }
    if (rootfilePaths.length === 0) {
        // 标签畸形时退回宽松扫描
        const loose = containerXml.match(/full-path\s*=\s*["']([^"']+)["']/i);
        if (loose) rootfilePaths.push(loose[1]);
    }
    if (rootfilePaths.length === 0) throw new Error("Invalid EPUB: no rootfile");

    // 2. Parse OPF (package document)
    let opfXml: string | null = null;
    let rootfilePath = rootfilePaths[0];
    for (const candidate of rootfilePaths) {
        const text = await readZipText(zip, resolveZipPath("", candidate));
        if (text) { opfXml = text; rootfilePath = candidate; break; }
    }
    if (!opfXml) throw new Error("Invalid EPUB: missing OPF");
    const rootDir = rootfilePath.includes("/") ? rootfilePath.substring(0, rootfilePath.lastIndexOf("/") + 1) : "";

    // Extract title and author（剥掉 CDATA 标记与残留标签）
    const cleanMeta = (raw?: string) => {
        const value = stripHtmlTags((raw || "").replace(/<!\[CDATA\[|\]\]>/g, "")).trim();
        return value || undefined;
    };
    const titleMatch = opfXml.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i);
    const authorMatch = opfXml.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i);
    const bookTitle = cleanMeta(titleMatch?.[1]) || fileName?.replace(/\.[^.]+$/, "") || "未命名";
    const author = cleanMeta(authorMatch?.[1]);

    // 3. Extract spine order (reading order)
    const spineItems: string[] = [];
    const spineMatch = opfXml.match(/<spine[^>]*>([\s\S]*?)<\/spine>/i);
    if (spineMatch) {
        const itemRefPattern = /<itemref\b[^>]*\/?>/gi;
        let m: RegExpExecArray | null;
        while ((m = itemRefPattern.exec(spineMatch[1])) !== null) {
            const idref = attrValue(m[0], "idref");
            if (idref) spineItems.push(idref);
        }
        if (spineItems.length === 0) {
            // 标签畸形（未闭合等）时退回属性扫描
            const looseRefs = spineMatch[1].match(/idref\s*=\s*["']([^"']+)["']/gi) || [];
            for (const ref of looseRefs) {
                const value = ref.replace(/^idref\s*=\s*["']/i, "").replace(/["']$/, "");
                if (value) spineItems.push(value);
            }
        }
    }

    // 4. Build id → href map from manifest
    const idToHref = parseManifestItems(opfXml);

    // 5. Read each spine item and extract text
    const chapters: ParsedChapter[] = [];
    for (const itemId of spineItems) {
        const href = idToHref.get(itemId);
        if (!href) continue;
        // 先按 OPF 所在目录解析；取不到再试「相对 ZIP 根」的扁路径（部分书 OPF 在子目录但引用不带前缀）
        let html = await readZipText(zip, resolveZipPath(rootDir, href));
        if (!html && rootDir) html = await readZipText(zip, resolveZipPath("", href));
        if (!html) continue;

        // Extract text from HTML
        const { title, paragraphs } = extractTextFromHtml(html);
        if (paragraphs.length === 0) continue;
        chapters.push({ title: title || `第${chapters.length + 1}章`, paragraphs });
    }

    if (chapters.length === 0) {
        return { title: bookTitle, author, chapters: [{ title: "全文", paragraphs: ["（EPUB 解析失败，未找到文本内容）"] }] };
    }

    return { title: bookTitle, author, chapters };
}

const EPUB_BLOCK_TAGS = new Set([
    "p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6",
    "blockquote", "td", "th", "dd", "dt", "section", "article", "figcaption", "pre",
]);

function normalizeInlineText(value: string | null | undefined): string {
    return (value || "").replace(/\s+/g, " ").trim();
}

/** 元素自身的直接文本（不含子元素内的文本），用于嵌套块场景下不丢外层文字 */
function directTextOf(element: Element): string {
    return normalizeInlineText(
        Array.from(element.childNodes)
            .filter((node) => node.nodeType === 3)
            .map((node) => node.textContent || "")
            .join(" "),
    );
}

/**
 * 用 DOMParser 抽取正文：只取「内部不再含块级子元素」的叶子块。
 * 既避免嵌套 <div> 被重复取文本，也不会像非贪婪正则那样在第一个 </div> 处提前收尾，
 * 还能覆盖 <blockquote>/<td>/<h4>+ 等旧正则完全不看的标签。
 * 返回 null 表示 DOM 路径不可用或没抽到内容，由调用方回退正则方案。
 */
function extractParagraphsFromDom(html: string): { title: string; paragraphs: string[] } | null {
    if (typeof DOMParser === "undefined") return null;
    let doc: Document;
    try {
        doc = new DOMParser().parseFromString(html, "text/html");
    } catch {
        return null;
    }
    const body = doc.body;
    if (!body) return null;

    // 样式/脚本里的文字不是正文
    body.querySelectorAll("script, style, noscript").forEach((node) => node.remove());

    const paragraphs: string[] = [];
    const walk = (element: Element) => {
        const own = directTextOf(element);
        if (own) paragraphs.push(own);
        for (const child of Array.from(element.children)) {
            const tag = child.tagName.toLowerCase();
            if (!EPUB_BLOCK_TAGS.has(tag)) {
                walk(child);
                continue;
            }
            const hasBlockChild = Array.from(child.children)
                .some((inner) => EPUB_BLOCK_TAGS.has(inner.tagName.toLowerCase()));
            if (hasBlockChild) {
                walk(child);
            } else {
                const text = normalizeInlineText(child.textContent);
                if (text) paragraphs.push(text);
            }
        }
    };
    walk(body);

    // 完全没有块级标签的书：整段文本退回按换行切
    if (paragraphs.length === 0) {
        const plain = normalizeInlineText(body.textContent);
        if (plain) paragraphs.push(...plain.split(/\n+/).map((line) => line.trim()).filter(Boolean));
    }

    if (paragraphs.length === 0) return null;
    return { title: findHeadingText(body), paragraphs };
}

function findHeadingText(root: Element): string {
    for (const selector of ["h1", "h2", "h3"]) {
        const text = normalizeInlineText(root.querySelector(selector)?.textContent);
        if (text) return text;
    }
    return "";
}

/** Extract readable text from HTML/XHTML content. */
function extractTextFromHtml(html: string): { title: string; paragraphs: string[] } {
    const domResult = extractParagraphsFromDom(html);
    const paragraphs = domResult?.paragraphs ?? [];
    let title = domResult?.title || "";

    // 正文标题兜底：<h1>-<h3> 或 <title>
    if (!title) {
        const titleMatch = html.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i)
            || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        title = titleMatch ? stripHtmlTags(titleMatch[1]).trim() : "";
    }

    // DOMParser 不可用（或 HTML 畸形到解析不出块级节点）时回退正则方案
    if (paragraphs.length === 0) {
        const blockPattern = /<(?:p|div|li|blockquote|td|h[1-6])[^>]*>([\s\S]*?)<\/(?:p|div|li|blockquote|td|h[1-6])>/gi;
        let match: RegExpExecArray | null;
        while ((match = blockPattern.exec(html)) !== null) {
            const text = stripHtmlTags(match[1]).trim();
            if (text.length > 0) paragraphs.push(text);
        }
    }

    // 最后兜底：整页去标签后按空行切
    if (paragraphs.length === 0) {
        const plainText = stripHtmlTags(html).trim();
        if (plainText) {
            paragraphs.push(...plainText.split(/\n{2,}/).map(l => l.trim()).filter(l => l.length > 0));
        }
    }

    return { title, paragraphs };
}

function decodeCodePoint(code: number): string {
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
    try {
        return String.fromCodePoint(code);
    } catch {
        return "";
    }
}

function stripHtmlTags(html: string): string {
    return html
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&")
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => decodeCodePoint(parseInt(code, 16)))
        .replace(/&#(\d+);/g, (_, code) => decodeCodePoint(Number(code)))
        .replace(/\s+/g, " ");
}

// ── PDF Parsing ──

/**
 * Parse PDF file into chapters (pages) and paragraphs.
 * Each page becomes a "chapter" since PDFs don't have semantic chapters.
 */
export type PdfParagraphMeta = {
    text: string;
    pageNum: number;       // 1-based page number
    yRatio: number;        // 0-1 vertical position within the page (0=top, 1=bottom)
};
export const PDF_PAGES_PER_CHAPTER = 5;

export type ParsedPdfChunk = ParsedChapter & {
    startPage: number;
    endPage: number;
    pdfMeta: PdfParagraphMeta[];
};

function buildPdfChunkTitle(startPage: number, endPage: number): string {
    return `第${startPage}-${endPage}页`;
}

async function openPdfDocument(source: PdfSource): Promise<{ pdf: any; dispose: () => Promise<void> }> {
    const pdfjsLib = await loadPdfjs();
    if (source instanceof Blob) {
        const url = URL.createObjectURL(source);
        const pdf = await pdfjsLib.getDocument({ url }).promise;
        return {
            pdf,
            dispose: async () => {
                URL.revokeObjectURL(url);
            },
        };
    }

    const pdf = await pdfjsLib.getDocument(new Uint8Array(source)).promise;
    return {
        pdf,
        dispose: async () => {},
    };
}

async function readPdfBaseMeta(pdf: any, fileName?: string) {
    const bookTitle = fileName?.replace(/\.[^.]+$/, "") || "未命名";
    const metadata = await pdf.getMetadata().catch(() => null);
    const info = metadata?.info as Record<string, unknown> | undefined;
    return {
        title: (info?.Title as string | undefined) || bookTitle,
        author: (info?.Author as string | undefined)?.trim() || undefined,
        totalPages: pdf.numPages,
    };
}

export async function inspectPdfFile(source: PdfSource, fileName?: string): Promise<ParsedBook & { totalPages: number }> {
    const { pdf, dispose } = await openPdfDocument(source);
    try {
        const base = await readPdfBaseMeta(pdf, fileName);
        const chapters: ParsedChapter[] = [];
        for (let startPage = 1; startPage <= base.totalPages; startPage += PDF_PAGES_PER_CHAPTER) {
            const endPage = Math.min(startPage + PDF_PAGES_PER_CHAPTER - 1, base.totalPages);
            chapters.push({
                title: buildPdfChunkTitle(startPage, endPage),
                paragraphs: [],
            });
        }
        return { title: base.title, author: base.author, totalPages: base.totalPages, chapters };
    } finally {
        try {
            await pdf.destroy?.();
        } catch {
            // Ignore cleanup failures from PDF.js.
        }
        await dispose();
    }
}

export async function parsePdfPageRange(
    source: PdfSource,
    options: { startPage: number; endPage: number; fileName?: string },
): Promise<{ title: string; author?: string; totalPages: number; chunks: ParsedPdfChunk[] }> {
    const { pdf, dispose } = await openPdfDocument(source);
    const base = await readPdfBaseMeta(pdf, options.fileName);
    const startPage = Math.max(1, Math.min(base.totalPages, options.startPage));
    const endPage = Math.max(startPage, Math.min(base.totalPages, options.endPage));
    const chunkMap = new Map<number, ParsedPdfChunk>();

    const ensureChunk = (pageNum: number) => {
        const chunkStart = Math.floor((pageNum - 1) / PDF_PAGES_PER_CHAPTER) * PDF_PAGES_PER_CHAPTER + 1;
        let chunk = chunkMap.get(chunkStart);
        if (!chunk) {
            const chunkEnd = Math.min(chunkStart + PDF_PAGES_PER_CHAPTER - 1, base.totalPages);
            chunk = {
                title: buildPdfChunkTitle(chunkStart, chunkEnd),
                startPage: chunkStart,
                endPage: chunkEnd,
                paragraphs: [],
                pdfMeta: [],
            };
            chunkMap.set(chunkStart, chunk);
        }
        return chunk;
    };

    for (let i = startPage; i <= endPage; i += 1) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const viewport = page.getViewport({ scale: 1 });
        const pageHeight = viewport.height;
        const chunk = ensureChunk(i);

        const items = textContent.items as { str?: string; transform?: number[] }[];
        const lines: { text: string; y: number }[] = [];
        let currentLine = "";
        let currentY = -1;

        for (const item of items) {
            const str = item.str || "";
            if (!str.trim()) continue;
            const y = item.transform ? item.transform[5] : 0;

            if (currentY < 0 || Math.abs(y - currentY) < 3) {
                currentLine += str;
                if (currentY < 0) currentY = y;
            } else {
                if (currentLine.trim()) lines.push({ text: currentLine.trim(), y: currentY });
                currentLine = str;
                currentY = y;
            }
        }
        if (currentLine.trim()) lines.push({ text: currentLine.trim(), y: currentY });

        let paraText = "";
        let paraY = 0;
        for (let j = 0; j < lines.length; j += 1) {
            if (paraText === "") {
                paraText = lines[j].text;
                paraY = lines[j].y;
            } else {
                const gap = Math.abs(lines[j].y - lines[j - 1].y);
                if (gap > 20) {
                    if (paraText.length > 5) {
                        const meta = { text: paraText, pageNum: i, yRatio: Math.max(0, Math.min(1, 1 - paraY / pageHeight)) };
                        chunk.pdfMeta.push(meta);
                        chunk.paragraphs.push(meta.text);
                    }
                    paraText = lines[j].text;
                    paraY = lines[j].y;
                } else {
                    paraText += " " + lines[j].text;
                }
            }
        }
        if (paraText.length > 5) {
            const meta = { text: paraText, pageNum: i, yRatio: Math.max(0, Math.min(1, 1 - paraY / pageHeight)) };
            chunk.pdfMeta.push(meta);
            chunk.paragraphs.push(meta.text);
        }

        page.cleanup?.();
        if (i % 12 === 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
    }

    try {
        await pdf.destroy?.();
    } catch {
        // Ignore cleanup failures from PDF.js.
    }
    await dispose();

    return {
        title: base.title,
        author: base.author,
        totalPages: base.totalPages,
        chunks: [...chunkMap.values()].sort((a, b) => a.startPage - b.startPage),
    };
}
