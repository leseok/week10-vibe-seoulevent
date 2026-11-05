// 브라우저는 같은 출처의 서버리스 API만 호출하며 인증키를 보관하지 않습니다.
const TIMEOUT_MS = 55000;
const DAY_MS = 86400000;
const $ = (id) => document.getElementById(id);
const state = { events: [], range: null, complete: false, loading: false };
const detailCache = new Map();
let detailSequence = 0;
let selectedEvent = null;
let returnFocus = null;

class ApiError extends Error {
  constructor(kind, message) { super(message); this.name = "ApiError"; this.kind = kind; }
}

function validDate(value) {
  const text = String(value ?? "").trim();
  if (!/^\d{8}$/.test(text)) return "";
  const time = Date.UTC(Number(text.slice(0, 4)), Number(text.slice(4, 6)) - 1, Number(text.slice(6, 8)));
  return new Date(time).toISOString().slice(0, 10).replaceAll("-", "") === text ? text : "";
}
function formatDate(value) {
  const date = validDate(value);
  return date ? `${date.slice(0, 4)}.${date.slice(4, 6)}.${date.slice(6, 8)}` : "날짜 정보 없음";
}
function period(event) { return `${formatDate(event.eventstartdate)} ~ ${formatDate(event.eventenddate)}`; }
function address(event) { return [event.addr1, event.addr2].map((v) => String(v ?? "").trim()).filter(Boolean).join(" "); }
function title(event) { return String(event.title ?? "").trim() || "행사명 정보 없음"; }
// 서버가 정리한 한국어 오류만 표시하고 플랫폼의 HTML 오류는 그대로 출력하지 않습니다.
async function requestApi(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(path, { signal: controller.signal, cache: "no-store" });
    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); }
    catch { throw new ApiError("response", "서버 API 응답을 읽지 못했습니다. 로컬에서는 Live Server 대신 vercel dev로 실행해 주세요. 배포한 경우 서버 함수의 실행 상태를 확인해 주세요."); }
    if (!response.ok) {
      const kind = ({ 429: "quota", 504: "timeout", 500: "server" })[response.status] || "response";
      throw new ApiError(kind, typeof data?.error === "string" ? data.error : "서버에서 행사를 가져오지 못했습니다. 잠시 후 다시 시도해 주세요.");
    }
    if (!data || typeof data !== "object" || Array.isArray(data) || data.error) throw new ApiError("response", "서버 응답 형식이 올바르지 않습니다. 다시 조회해 주세요.");
    return data;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (controller.signal.aborted) throw new ApiError("timeout", "요청 시간이 초과되었습니다. 잠시 후 다시 조회해 주세요.");
    throw new ApiError("network", "서버에 연결하지 못했습니다. 네트워크 연결을 확인하고 다시 조회해 주세요.");
  } finally { clearTimeout(timer); }
}

function setStatus(kind, heading, message, retry = false, clear = false) {
  $("status-panel").hidden = false;
  $("status-panel").dataset.kind = kind;
  $("status-symbol").textContent = kind === "loading" ? "↻" : kind === "empty" ? "⌕" : "▦";
  $("status-title").textContent = heading;
  $("status-message").textContent = message;
  $("retry-button").hidden = !retry;
  $("clear-search-button").hidden = !clear;
}

// 날짜 범위와 최종 개수는 전체 페이지를 조회한 서버의 응답을 사용합니다.
async function loadEvents() {
  if (state.loading) return;
  if ($("detail-dialog").open) $("detail-dialog").close();
  state.events = [];
  state.complete = false;
  state.loading = true;
  $("date-range").textContent = "서버 조회 기간 확인 중";
  $("event-grid").replaceChildren();
  $("event-count").textContent = "—";
  $("results-description").textContent = "조회 완료 후 행사명과 주소로 검색할 수 있어요.";
  $("refresh-button").disabled = true;
  $("retry-button").disabled = true;
  $("event-grid").setAttribute("aria-busy", "true");
  setStatus("loading", "서울의 행사를 불러오고 있어요", "전체 행사 페이지를 확인하고 있어요. 잠시만 기다려 주세요.");
  try {
    const data = await requestApi("/api/events");
    const start = validDate(data.startDate), end = validDate(data.endDate);
    const toTime = (date) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8)));
    if (!start || !end || toTime(end) - toTime(start) !== 6 * DAY_MS || !Array.isArray(data.items) || !Number.isSafeInteger(data.totalCount) || data.totalCount !== data.items.length || !data.items.every((item) => item && typeof item === "object" && /^\d+$/.test(String(item.contentid)) && validDate(item.eventstartdate) >= start && validDate(item.eventstartdate) <= end)) {
      throw new ApiError("response", "서버의 행사 목록 형식이 올바르지 않습니다. 다시 조회해 주세요.");
    }
    state.range = { start, end, startTime: toTime(start) };
    state.events = data.items.map((item) => ({ ...item, contentid: String(item.contentid) }));
    state.complete = true;
    $("date-range").textContent = `${formatDate(start)} ~ ${formatDate(end)}`;
    $("event-count").textContent = `${data.totalCount}개`;
    const updated = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
    $("last-updated").textContent = `마지막 조회 완료: ${updated} (서울 기준)`;
    renderEvents();
  } catch (error) {
    const heading = { quota: "호출 한도를 확인해 주세요", server: "서버 설정을 확인해 주세요", network: "행사를 불러오지 못했어요", timeout: "응답을 기다리는 시간이 길어지고 있어요" }[error.kind] || "행사 조회가 완료되지 않았어요";
    setStatus(error.kind || "response", heading, error instanceof ApiError ? error.message : "응답 처리 중 오류가 발생했습니다. 다시 조회해 주세요.", true);
    $("date-range").textContent = "조회 기간 확인 실패";
    $("results-description").textContent = "전체 조회 미완료 · 결과 개수를 확인할 수 없습니다.";
  } finally {
    state.loading = false;
    $("refresh-button").disabled = false;
    $("retry-button").disabled = false;
    $("event-grid").setAttribute("aria-busy", "false");
  }
}

// 위도는 mapy, 경도는 mapx이며 유효하지 않으면 주소를 사용합니다.
function mapUrl(event) {
  const latitude = String(event.mapy ?? "").trim();
  const longitude = String(event.mapx ?? "").trim();
  const lat = Number(latitude), lng = Number(longitude);
  const valid = latitude && longitude && Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0 && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  const query = valid ? `${lat},${lng}` : address(event);
  return query ? `https://www.google.com/maps/search/?${new URLSearchParams({ api: "1", query })}` : "";
}
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function imageUrl(value) {
  try { const url = new URL(String(value)); return ["https:", "http:"].includes(url.protocol) ? url.href : ""; }
  catch { return ""; }
}

function createCard(event) {
  const card = element("article", "event-card");
  const visual = element("div", "card-visual");
  const placeholder = element("div", "image-placeholder");
  placeholder.append(element("span", "", "서울의 즐거운 발견"));
  placeholder.setAttribute("role", "img");
  placeholder.setAttribute("aria-label", "행사 대표이미지 없음");
  visual.append(placeholder);
  const sources = [...new Set([imageUrl(event.firstimage), imageUrl(event.firstimage2)].filter(Boolean))];
  if (sources.length) {
    const img = element("img", "card-image");
    img.alt = `${title(event)} 대표이미지`;
    img.loading = "lazy";
    img.decoding = "async";
    let index = 0;
    img.addEventListener("load", () => { placeholder.hidden = true; });
    img.addEventListener("error", () => {
      index += 1;
      if (index < sources.length) img.src = sources[index];
      else { img.remove(); placeholder.hidden = false; }
    });
    img.src = sources[0];
    visual.append(img);
  }
  const date = validDate(event.eventstartdate);
  const day = Math.round((Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8))) - state.range.startTime) / DAY_MS);
  visual.append(element("span", `day-badge${day === 0 ? " today" : ""}`, day === 0 ? "오늘 시작" : `D-${day}`));
  const body = element("div", "card-body");
  body.append(element("h3", "", title(event)));
  for (const [label, value, className] of [["기간", period(event), ""], ["장소", address(event) || "주소 정보 없음", " card-address"]]) {
    const row = element("p", `card-meta${className}`);
    row.append(element("strong", "", label), element("span", "", value));
    body.append(row);
  }
  const actions = element("div", "card-actions");
  const details = element("button", "button button-primary", "상세보기");
  details.type = "button";
  details.setAttribute("aria-label", `${title(event)} 상세보기`);
  details.addEventListener("click", () => openDetails(event, details));
  actions.append(details);
  const url = mapUrl(event);
  if (url) {
    const link = element("a", "button button-white", "지도 보기 ↗");
    link.href = url; link.target = "_blank"; link.rel = "noopener noreferrer";
    link.setAttribute("aria-label", `${title(event)} 지도 보기 (새 탭)`);
    actions.append(link);
  } else actions.append(element("span", "no-location", "위치 정보 없음"));
  body.append(actions);
  card.append(visual, body);
  return card;
}

function renderEvents() {
  if (!state.complete) return;
  const query = $("search-input").value.trim().normalize("NFC").toLocaleLowerCase("ko-KR");
  const events = state.events.filter((event) => `${title(event)} ${address(event)}`.normalize("NFC").toLocaleLowerCase("ko-KR").includes(query));
  events.sort((a, b) => ($("sort-select").value === "date" ? validDate(a.eventstartdate).localeCompare(validDate(b.eventstartdate)) : 0) || title(a).localeCompare(title(b), "ko") || a.contentid.localeCompare(b.contentid));
  $("event-grid").replaceChildren(...events.map(createCard));
  $("status-panel").hidden = true;
  $("results-description").textContent = query ? `이번 주 행사 ${state.events.length}개 중 검색 결과 ${events.length}개` : `이번 주에 시작하는 행사 ${events.length}개 · 마음이 가는 일정을 찾아보세요.`;
  if (!state.events.length) setStatus("empty", "이번 주에 시작하는 행사가 없어요", "조회 기간에 새로 시작하는 서울 행사가 없습니다. 다른 날 다시 확인해 주세요.", true);
  else if (!events.length) setStatus("empty", "검색 결과가 없어요", "행사명이나 주소를 다른 검색어로 찾아보세요.", false, true);
}

// 상세 문자열의 줄바꿈 표식만 텍스트로 정리하고 외부 HTML은 삽입하지 않습니다.
function detailText(value) {
  const text = String(value ?? "").replace(/<br\s*\/?\s*>/gi, "\n").trim();
  return text || "정보 없음";
}
function renderDetailFields(item = {}) {
  $("detail-fields").replaceChildren();
  for (const [field, label] of [["eventplace", "행사장"], ["playtime", "행사 시간"], ["usetimefestival", "이용요금"], ["sponsor1", "주최자"], ["sponsor1tel", "주최자 연락처"]]) {
    const row = element("div", "detail-row");
    row.append(element("dt", "", label), element("dd", "", detailText(item[field])));
    $("detail-fields").append(row);
  }
}
function getIntro(event) {
  const id = event.contentid;
  if (!detailCache.has(id)) {
    const pending = requestApi(`/api/events?${new URLSearchParams({ contentId: id })}`).then((body) => {
      if (!("item" in body) || (body.item !== null && (typeof body.item !== "object" || Array.isArray(body.item)))) throw new ApiError("response", "상세정보 응답 형식이 올바르지 않습니다.");
      return body.item || {};
    }).catch((error) => { detailCache.delete(id); throw error; });
    detailCache.set(id, pending);
  }
  return detailCache.get(id);
}
async function loadDetails(event) {
  const sequence = ++detailSequence;
  $("detail-status").textContent = "상세정보를 불러오는 중입니다.";
  $("detail-retry").hidden = true;
  renderDetailFields();
  try {
    const item = await getIntro(event);
    if (sequence !== detailSequence || !$("detail-dialog").open) return;
    renderDetailFields(item);
    $("detail-status").textContent = "상세정보 조회 완료 · 세부 일정은 주최자에게 확인해 주세요.";
  } catch (error) {
    if (sequence !== detailSequence || !$("detail-dialog").open) return;
    $("detail-status").textContent = `상세정보를 불러오지 못했습니다. 행사명·기간·주소는 계속 확인할 수 있습니다. ${error instanceof ApiError ? error.message : "다시 시도해 주세요."}`;
    $("detail-retry").hidden = false;
  }
}
function openDetails(event, button) {
  selectedEvent = event;
  returnFocus = button;
  $("detail-title").textContent = title(event);
  $("detail-period").textContent = period(event);
  $("detail-address").textContent = address(event) || "주소 정보 없음";
  const url = mapUrl(event);
  $("detail-map").hidden = !url;
  $("detail-no-location").hidden = Boolean(url);
  if (url) $("detail-map").href = url;
  else $("detail-map").removeAttribute("href");
  $("detail-dialog").showModal();
  $("detail-dialog").scrollTop = 0;
  loadDetails(event);
}

// 검색과 정렬은 메모리의 목록만 사용하며 API를 다시 호출하지 않습니다.
$("refresh-button").addEventListener("click", loadEvents);
$("retry-button").addEventListener("click", loadEvents);
$("search-input").addEventListener("input", renderEvents);
$("sort-select").addEventListener("change", renderEvents);
$("clear-search-button").addEventListener("click", () => { $("search-input").value = ""; renderEvents(); $("search-input").focus(); });
$("close-dialog").addEventListener("click", () => $("detail-dialog").close());
$("detail-dialog").addEventListener("close", () => { detailSequence += 1; selectedEvent = null; if (returnFocus?.isConnected) returnFocus.focus(); });
$("detail-retry").addEventListener("click", () => { if (selectedEvent) loadDetails(selectedEvent); });
loadEvents();
