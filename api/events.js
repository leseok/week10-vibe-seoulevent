// 인증키와 한국관광공사 요청은 이 서버리스 함수 안에서만 다룹니다.
const API_BASE = "https://apis.data.go.kr/B551011/KorService2/";
const REQUEST_TIMEOUT_MS = 12000;
const TOTAL_TIMEOUT_MS = 45000;
const DAY_MS = 86400000;
const LIST_FIELDS = ["contentid", "title", "eventstartdate", "eventenddate", "addr1", "addr2", "firstimage", "firstimage2", "mapx", "mapy", "tel"];
const DETAIL_FIELDS = ["eventplace", "playtime", "usetimefestival", "sponsor1", "sponsor1tel"];

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function readKey() {
  const encoded = process.env.TOUR_API_KEY?.trim();
  if (!encoded) throw new ApiError(500, "서버 환경변수 TOUR_API_KEY가 설정되지 않았습니다. 설정 후 다시 실행하거나 재배포해 주세요.");
  try {
    // Encoding 키를 정확히 한 번 복원한 뒤 URLSearchParams에 전달합니다.
    const decoded = decodeURIComponent(encoded);
    if (!decoded || /\s|[\u0000-\u001f\u007f]/.test(decoded)) throw new Error();
    return { decoded, encoded };
  } catch {
    throw new ApiError(500, "TOUR_API_KEY의 인코딩 형식이 잘못되었습니다. 공공데이터포털의 Encoding 인증키를 다시 등록해 주세요.");
  }
}

function getSeoulRange(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (name) => Number(parts.find((item) => item.type === name).value);
  const time = Date.UTC(part("year"), part("month") - 1, part("day"));
  const compact = (value) => new Date(value).toISOString().slice(0, 10).replaceAll("-", "");
  return { startDate: compact(time), endDate: compact(time + 6 * DAY_MS) };
}

function validDate(value) {
  const date = String(value ?? "").trim();
  if (!/^\d{8}$/.test(date)) return "";
  const time = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8)));
  return new Date(time).toISOString().slice(0, 10).replaceAll("-", "") === date ? date : "";
}

function externalError() { return new ApiError(502, "외부 API 응답이 올바르지 않습니다. 잠시 후 다시 조회해 주세요."); }
function normalizeItems(items) {
  const item = items?.item;
  if (item == null || item === "") return [];
  const list = Array.isArray(item) ? item : [item];
  if (list.some((value) => !value || typeof value !== "object" || Array.isArray(value))) throw externalError();
  return list;
}

function classifyError(code, message, status) {
  const value = String(code ?? "").trim();
  const text = String(message ?? "");
  if (status === 429 || ["20", "22"].includes(value) || /LIMITED_NUMBER|TOO_MANY|quota|한도|초과/i.test(text + value)) {
    return new ApiError(429, "TourAPI 호출 한도를 초과했습니다. 공공데이터포털의 이용 한도를 확인하고 나중에 다시 조회해 주세요.");
  }
  if ([401, 403].includes(status) || ["30", "31", "32"].includes(value) || /SERVICE_KEY|ACCESS_DENIED|UNREGISTERED|인증|등록되지|만료/i.test(text + value)) {
    return new ApiError(502, "TourAPI 인증 오류입니다. 서버에 등록한 Encoding 인증키와 서비스 활용 승인을 확인해 주세요.");
  }
  if ([408, 504].includes(status)) return new ApiError(504, "외부 API 요청 시간이 초과되었습니다. 잠시 후 다시 조회해 주세요.");
  return externalError();
}

async function requestTour(endpoint, parameters, key, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new ApiError(504, "전체 행사 조회 시간이 초과되었습니다. 조회가 완료되지 않았으니 다시 시도해 주세요.");
  const query = new URLSearchParams({ serviceKey: key.decoded, MobileOS: "WEB", MobileApp: "SeoulWeekEvents", _type: "json", ...parameters });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(REQUEST_TIMEOUT_MS, remaining));
  try {
    const response = await fetch(`${API_BASE}${endpoint}?${query}`, { signal: controller.signal, redirect: "error" });
    const raw = await response.text();
    // XML 원문에는 키나 요청 URL이 들어갈 수 있으므로 그대로 반환하지 않습니다.
    if (raw.trimStart().startsWith("<")) throw new ApiError(502, "인증키 또는 요청값을 확인해주세요");
    let data;
    try { data = JSON.parse(raw); }
    catch { throw classifyError("", "", response.status); }
    const header = data?.response?.header;
    if (!response.ok || String(header?.resultCode) !== "0000") throw classifyError(header?.resultCode, header?.resultMsg, response.status);
    const body = data?.response?.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw externalError();
    return body;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (controller.signal.aborted) throw new ApiError(504, "외부 API 요청 시간이 초과되었습니다. 전체 조회가 완료되지 않았으니 다시 시도해 주세요.");
    throw new ApiError(502, "외부 API에 연결하지 못했습니다. 잠시 후 다시 조회해 주세요.");
  } finally { clearTimeout(timer); }
}

// 필요한 필드만 반환하고 응답 값에 인증키가 반영된 경우에도 제거합니다.
function publicItem(item, fields, key) {
  const secrets = [key.decoded, key.encoded, encodeURIComponent(key.decoded)];
  return Object.fromEntries(fields.map((field) => {
    let value = ["string", "number"].includes(typeof item[field]) ? String(item[field]).trim() : "";
    for (const secret of secrets) value = value.split(secret).join("[보호된 값]");
    return [field, value];
  }));
}

async function listEvents(key, deadline) {
  const range = getSeoulRange();
  const collected = new Map();
  let page = 1, totalPages = 1;
  while (page <= totalPages) {
    const body = await requestTour("searchFestival2", { lDongRegnCd: "11", eventStartDate: range.startDate, numOfRows: "100", pageNo: String(page), arrange: "A" }, key, deadline);
    const total = Number(body.totalCount), rows = Number(body.numOfRows), returnedPage = Number(body.pageNo);
    if (body.totalCount == null || body.totalCount === "" || !Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(rows) || rows < 1 || returnedPage !== page) throw externalError();
    totalPages = Math.max(1, Math.ceil(total / rows));
    const items = normalizeItems(body.items);
    if (total > 0 && !items.length) throw externalError();
    for (const item of items) {
      const id = String(item.contentid ?? "").trim();
      if (!/^\d+$/.test(id)) throw externalError();
      collected.set(id, publicItem(item, LIST_FIELDS, key));
    }
    page += 1;
  }
  // 모든 페이지를 받은 뒤 시작일로 필터링하며 종료일은 판정에 쓰지 않습니다.
  const items = [...collected.values()].filter((item) => {
    const start = validDate(item.eventstartdate);
    return start && start >= range.startDate && start <= range.endDate;
  }).sort((a, b) => a.eventstartdate.localeCompare(b.eventstartdate) || a.title.localeCompare(b.title, "ko") || a.contentid.localeCompare(b.contentid));
  return { items, totalCount: items.length, ...range };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "GET 요청만 허용합니다." });
  }
  try {
    const values = new URL(req.url || "/api/events", "http://localhost").searchParams.getAll("contentId");
    const contentId = values.length ? values[0] : req.query?.contentId;
    if (values.length > 1 || Array.isArray(req.query?.contentId) || (contentId !== undefined && (typeof contentId !== "string" || !/^\d+$/.test(contentId)))) {
      throw new ApiError(400, "contentId는 숫자로 이루어진 단일 값이어야 합니다.");
    }
    const key = readKey();
    const deadline = Date.now() + TOTAL_TIMEOUT_MS;
    if (contentId !== undefined) {
      const body = await requestTour("detailIntro2", { contentId, contentTypeId: "15" }, key, deadline);
      const item = normalizeItems(body.items)[0];
      return res.status(200).json({ item: item ? publicItem(item, DETAIL_FIELDS, key) : null });
    }
    return res.status(200).json(await listEvents(key, deadline));
  } catch (error) {
    // 예외 원문과 원본 요청 URL을 응답이나 로그로 내보내지 않습니다.
    return res.status(error instanceof ApiError ? error.status : 500).json({ error: error instanceof ApiError ? error.message : "서버에서 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요." });
  }
};
