const $ = (selector) => document.querySelector(selector);
const root = document.documentElement;
const themeMeta = document.querySelector('meta[name="theme-color"]');
const form = $("#search-form");
const input = $("#domain-input");
const submit = $("#submit-button");
const feedback = $("#feedback");
const emptyState = $("#empty-state");
const loadingState = $("#loading-state");
const errorState = $("#error-state");
const resultState = $("#result-state");
const domainFilter = $("#domain-filter");
const showAllButton = $("#show-all");
let activeController;
let currentDomains = [];
let showAll = false;

function setState(state) {
  emptyState.classList.toggle("hidden", state !== "empty");
  loadingState.classList.toggle("hidden", state !== "loading");
  errorState.classList.toggle("hidden", state !== "error");
  resultState.classList.toggle("hidden", state !== "result");
}

function normalizeInput(value) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const url = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  })[char]);
}

function formatDate(value, includeTime = false) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
    ...(includeTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(date);
}

function toast(message = "已复制") {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  setTimeout(() => element.classList.remove("show"), 1400);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast();
  } catch {
    toast("复制失败");
  }
}

function renderDomains() {
  const filter = domainFilter.value.trim().toLowerCase();
  const filtered = currentDomains.filter((domain) => domain.includes(filter));
  const visible = showAll || filter ? filtered : filtered.slice(0, 100);
  $("#domain-list").innerHTML = visible.length
    ? visible.map((domain) => `<div class="domain-row"><span class="domain-name">${escapeHtml(domain)}</span>${domain.startsWith("*.") ? '<span class="wildcard">Wildcard</span>' : ""}<button class="copy-button" type="button" data-copy="${escapeHtml(domain)}" aria-label="复制 ${escapeHtml(domain)}">复制</button></div>`).join("")
    : '<p class="empty-inline">没有匹配的域名。</p>';
  showAllButton.classList.toggle("hidden", Boolean(filter) || currentDomains.length <= 100);
  showAllButton.textContent = showAll ? "收起" : `显示全部（${currentDomains.length}）`;
}

const STATUS = {
  valid: ["有效", "status-valid"],
  expired: ["已过期", "status-expired"],
  not_yet_valid: ["尚未生效", "status-not_yet_valid"],
};

function renderCertificates(certificates) {
  $("#certificate-list").innerHTML = certificates.length
    ? certificates.map((cert) => {
      const [statusLabel, statusClass] = STATUS[cert.status] || STATUS.valid;
      const crtLink = cert.id ? `https://crt.sh/?id=${encodeURIComponent(cert.id)}` : "https://crt.sh/";
      return `<details class="certificate"><summary><span class="cert-main"><span class="cert-domain">${escapeHtml(cert.commonName || cert.names[0] || "未知域名")}</span><span class="cert-issuer">${escapeHtml(cert.issuer || "未知签发机构")}</span></span><span class="cert-dates">${formatDate(cert.notBefore)} → ${formatDate(cert.notAfter)}</span><span class="status-badge ${statusClass}">${statusLabel}</span></summary><div class="cert-detail"><div><span>Common Name</span><strong>${escapeHtml(cert.commonName || "—")}</strong></div><div><span>SAN</span><strong>${escapeHtml(cert.names.join(", ") || "—")}</strong></div><div><span>Issuer</span><strong>${escapeHtml(cert.issuer || "—")}</strong></div><div><span>Serial Number</span><strong>${escapeHtml(cert.serialNumber || "—")}</strong></div><div><span>有效期</span><strong>${formatDate(cert.notBefore)} → ${formatDate(cert.notAfter)}</strong></div><div><span>crt.sh ID</span><strong><a href="${crtLink}" target="_blank" rel="noopener noreferrer">${escapeHtml(cert.id || "在 crt.sh 搜索")}</a></strong></div></div></details>`;
    }).join("")
    : '<p class="empty-inline">暂未在公开证书日志中发现相关记录。</p>';
}

function renderResult(data, cacheStatus) {
  $("#summary-domain").textContent = data.domain;
  $("#domain-count").textContent = data.domains.length;
  $("#cert-count").textContent = data.certificates.length;
  $("#query-time").textContent = formatDate(data.queryTime, true);
  $("#cache-badge").textContent = {
    HIT: "缓存命中",
    STALE: "缓存回退",
    COOLDOWN: "数据源冷却中",
  }[cacheStatus] || "实时查询";
  currentDomains = data.domains;
  showAll = false;
  domainFilter.value = "";
  renderDomains();
  renderCertificates(data.certificates);
  setState("result");
}

async function search(rawValue) {
  const domain = normalizeInput(rawValue);
  if (!domain) {
    feedback.textContent = "请输入有效域名，例如 example.com。";
    feedback.className = "feedback error";
    input.focus();
    return;
  }

  activeController?.abort();
  activeController = new AbortController();
  submit.disabled = true;
  submit.textContent = "查询中…";
  feedback.textContent = "正在查询公开证书日志…";
  feedback.className = "feedback";
  setState("loading");
  const url = new URL(location.href);
  url.search = "";
  url.searchParams.set("q", domain);
  history.replaceState(null, "", url);

  try {
    const response = await fetch(`/api/search?domain=${encodeURIComponent(domain)}`, { signal: activeController.signal });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.message || "查询失败，请稍后重试。");
    input.value = domain;
    renderResult(data, response.headers.get("X-Cache"));
    feedback.textContent = response.headers.get("X-Cache") === "STALE"
      ? "crt.sh 暂时不可用，已显示近期缓存结果。"
      : data.certificates.length ? "查询完成。" : "查询完成，暂未发现相关记录。";
  } catch (error) {
    if (error.name === "AbortError") return;
    $("#error-message").textContent = error.message || "查询失败，请稍后重试。";
    feedback.textContent = "";
    setState("error");
  } finally {
    submit.disabled = false;
    submit.textContent = "查询";
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  search(input.value);
});
domainFilter.addEventListener("input", renderDomains);
showAllButton.addEventListener("click", () => { showAll = !showAll; renderDomains(); });
$("#domain-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-copy]");
  if (button) copyText(button.dataset.copy);
});

function initThreads() {
  const canvas = $(".threads-bg");
  const context = canvas.getContext("2d", { alpha: true });
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let lineRgb = [31, 126, 235];
  let width = 0, height = 0, ratio = 1, frame = 0;
  let mouse = { x: .5, y: .5 };
  let target = { x: .5, y: .5 };
  function refreshLineColor() {
    const value = getComputedStyle(root).getPropertyValue("--line-rgb").trim();
    if (value) lineRgb = value.split(",").map((part) => parseFloat(part.trim()));
  }
  function resize() {
    ratio = Math.min(devicePixelRatio || 1, 1.5); width = innerWidth; height = innerHeight;
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
  }
  function draw(time = 0) {
    context.clearRect(0, 0, width, height);
    mouse.x += (target.x - mouse.x) * .035;
    mouse.y += (target.y - mouse.y) * .035;
    const phase = time * .00016;
    const amplitude = Math.min(height * .13, 135) * (1 + (mouse.y - .5) * .18);
    const base = height * .28;
    context.lineCap = "round";
    for (let line = 0; line < 30; line += 1) {
      const progress = line / 29; context.beginPath();
      for (let x = -20; x <= width + 20; x += 12) {
        const nx = x / Math.max(width, 1);
        const fade = Math.pow(Math.max(0, nx), .72);
        const wave = Math.sin(nx * 7.2 + phase * 6 + progress * 4.6) + .46 * Math.sin(nx * 15.5 - phase * 3 + progress * 8.1);
        const y = base + progress * height * .42 + wave * amplitude * fade * .24 + (mouse.x - .5) * 32 * fade;
        x === -20 ? context.moveTo(x, y) : context.lineTo(x, y);
      }
      context.strokeStyle = `rgba(${lineRgb.join(",")},${.015 + (1 - progress) * .05})`;
      context.lineWidth = .7 + (1 - progress) * .7; context.stroke();
    }
    if (!reduced && !document.hidden) frame = requestAnimationFrame(draw);
  }
  addEventListener("resize", () => { resize(); draw(); }, { passive: true });
  addEventListener("pointermove", (event) => {
    target.x = event.clientX / Math.max(innerWidth, 1);
    target.y = 1 - event.clientY / Math.max(innerHeight, 1);
  }, { passive: true });
  refreshLineColor();
  addEventListener("ct-themechange", () => { refreshLineColor(); draw(); });
  resize(); draw();
  document.addEventListener("visibilitychange", () => {
    cancelAnimationFrame(frame);
    if (!document.hidden && !reduced) frame = requestAnimationFrame(draw);
  });
}

$("#theme-toggle").addEventListener("click", () => {
  const next = root.dataset.theme === "dark" ? "light" : "dark";
  root.dataset.theme = next;
  localStorage.setItem("ct-theme", next);
  themeMeta?.setAttribute("content", next === "dark" ? "#0b1730" : "#f4f7fb");
  dispatchEvent(new CustomEvent("ct-themechange"));
});

initThreads();
const initialQuery = new URLSearchParams(location.search).get("q");
if (initialQuery) { input.value = initialQuery; search(initialQuery); }
