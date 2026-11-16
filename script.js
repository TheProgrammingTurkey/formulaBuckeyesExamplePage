const DATA_FILE = "FormulaBuckeyesSpecs.csv";
let SEASONS = [];
let RECORDS = [];

const EVENTS = [
  "Cost", "Presentation", "Acceleration",
  "Skidpad", "Autocross", "Endurance", "Efficiency"
];

const ordinal = (number) => {
  const remainder = number % 100;
  const suffix = remainder >= 11 && remainder <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[number % 10] || "th");
  return `${number}${suffix}`;
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[character]);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let insideQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (insideQuotes) {
      if (character === "\"" && text[index + 1] === "\"") {
        field += "\"";
        index += 1;
      } else if (character === "\"") {
        insideQuotes = false;
      } else {
        field += character;
      }
    } else if (character === "\"" && field.length === 0) {
      insideQuotes = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      if (character === "\r" && text[index + 1] === "\n") index += 1;
    } else {
      field += character;
    }
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function yearsFromHeaders(headers) {
  const seasonColumns = headers
    .map((header, index) => {
      const match = /^FB-(\d{2})$/i.exec(header.trim());
      return match ? { index, suffix: Number(match[1]) } : null;
    })
    .filter(Boolean);
  if (!seasonColumns.length) throw new Error("No FB-YY season columns were found.");

  let previousYear = 2000 + seasonColumns[0].suffix;
  if (previousYear > new Date().getFullYear() + 20) previousYear -= 100;
  return seasonColumns.map((column, index) => {
    if (index === 0) return { index: column.index, year: previousYear };
    let year = Math.floor(previousYear / 100) * 100 + column.suffix;
    if (year >= previousYear) year -= 100;
    previousYear = year;
    return { index: column.index, year };
  });
}

function seasonCode(year) {
  return `FB-${String(year % 100).padStart(2, "0")}`;
}

function isUnavailableSpec(value) {
  return !value || /^(?:N\/A|N\.A\.?|NA|NONE|NOT AVAILABLE|\.{2,}|…+|[-–—]+)$/i.test(value);
}

async function loadArchiveData() {
  const response = await fetch(DATA_FILE);
  if (!response.ok) throw new Error(`CSV request failed (${response.status}).`);
  const rows = parseCsv((await response.text()).replace(/^\uFEFF/, ""));
  let tableStart = -1;
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index][1] && /^FB-\d{2}$/i.test(rows[index][1].trim())) tableStart = index;
  }
  if (tableStart < 0) throw new Error("No season table was found in the CSV.");

  // Use the last table when the export contains repeated copies of the sheet.
  const table = rows.slice(tableStart);
  const headers = table[0];
  const seasonColumns = yearsFromHeaders(headers);
  const rowsByLabel = new Map();
  for (const row of table.slice(1)) {
    const label = (row[0] || "").trim().toUpperCase();
    if (!label) continue;
    if (!rowsByLabel.has(label)) rowsByLabel.set(label, []);
    rowsByLabel.get(label).push(row);
  }

  const specRows = [];
  for (const row of table.slice(1)) {
    const label = (row[0] || "").trim();
    if (!label) continue;
    if (label.toUpperCase() === "SPECS PAGE") break;
    if (label.toUpperCase() === "EVENT") continue;
    specRows.push(row);
  }
  const specLabels = specRows.map((row) => row[0].trim()).filter(Boolean);
  const firstValue = (label, columnIndex) => {
    const matchingRows = rowsByLabel.get(label.toUpperCase()) || [];
    return (matchingRows[0] && matchingRows[0][columnIndex] || "").trim();
  };
  const lastValue = (label, columnIndex) => {
    const matchingRows = rowsByLabel.get(label.toUpperCase()) || [];
    return (matchingRows[matchingRows.length - 1]
      && matchingRows[matchingRows.length - 1][columnIndex] || "").trim();
  };

  const recordsByYear = new Map();
  for (const { index, year } of seasonColumns) {
    const specs = {};
    for (const label of specLabels) {
      const value = firstValue(label, index);
      if (!isUnavailableSpec(value)) specs[label] = value;
    }

    const results = EVENTS.map((event) => {
      const finish = firstValue(event, index) || "N/A";
      const rawTime = event === "Acceleration" || event === "Skidpad"
        ? lastValue(event, index)
        : "";
      const time = /^\d+(?:\.\d+)?$/.test(rawTime) ? `${rawTime} s` : null;
      return { event, finish, time };
    });
    const overall = firstValue("Overall Place", index) || "N/A";
    recordsByYear.set(year, {
      year,
      event: firstValue("Event", index),
      overall,
      specs,
      results
    });
  }

  SEASONS = Array.from(recordsByYear.keys())
    .filter((year) => year !== 2021)
    .sort((first, second) => second - first);
  RECORDS = SEASONS.map((year) => recordsByYear.get(year));
}

const elements = {
  timelineTrack: document.querySelector("#timelineTrack"),
  timelineRail: document.querySelector("#timelineRail"),
  timelineMarks: document.querySelector("#timelineMarks"),
  timelineCurrent: document.querySelector("#timelineCurrent"),
  trackProgress: document.querySelector("#trackProgress"),
  panelSeason: document.querySelector("#panelSeason"),
  panelOverall: document.querySelector("#panelOverall"),
  panelEvent: document.querySelector("#panelEvent"),
  panelContent: document.querySelector("#panelContent"),
  archivePanel: document.querySelector(".archive-panel")
};

let currentIndex = 0;
let scrollAccumulation = 0;
let panelEdgeAccumulation = 0;
let seasonTransitioning = false;
let touchStartY = null;
let touchStartedInTimeline = false;
let touchStartedInDataPanel = false;
let touchDataScrollTop = 0;
let hoveredYearMark = null;
const CHANGE_THRESHOLD = 360;
const PANEL_EDGE_THRESHOLD = 720;
const TIMELINE_STEP = 30;

// Render each season as a labeled row in the independently scrollable rail.
function renderTimeline() {
  elements.timelineRail.style.height = `${(SEASONS.length + 1) * TIMELINE_STEP}px`;
  elements.timelineMarks.innerHTML = SEASONS.map((year, index) => {
    const position = (index + 1) * TIMELINE_STEP;
    const active = index === currentIndex;
    return `<button class="year-mark${active ? " is-current" : ""}"
      type="button" style="--position:${position}px"
      data-index="${index}" data-year="${year}"
      aria-label="Show ${year} season" aria-current="${active ? "date" : "false"}">
      <span class="year-tick year-tick-before" aria-hidden="true"></span>
      <span class="year-tick year-tick-after" aria-hidden="true"></span>
      <span class="year-label" aria-hidden="true">${year}</span>
    </button>`;
  }).join("");
}

function renderSpecs(record) {
  const entries = Object.entries(record.specs);
  if (!entries.length) return "";
  const items = entries.map(([label, value]) => `
    <div class="spec-item">
      <span class="spec-label">${escapeHtml(label)}</span>
      <strong class="spec-value">${escapeHtml(value)}</strong>
    </div>`).join("");
  return `<div class="spec-grid">${items}</div>`;
}

function displayFinish(value) {
  return /^\d+$/.test(value) ? ordinal(Number(value)) : value;
}

function render() {
  const record = RECORDS[currentIndex];
  elements.timelineCurrent.textContent = record.year;
  elements.trackProgress.style.height = `${currentIndex * TIMELINE_STEP}px`;
  elements.panelSeason.textContent = seasonCode(record.year);
  elements.panelOverall.textContent = displayFinish(record.overall);
  elements.panelEvent.textContent = record.event;
  elements.panelEvent.hidden = !record.event;

  const resultCards = record.results.map(({ event, finish, time }) => {
    const numericFinish = /^\d+$/.test(finish);
    const position = displayFinish(finish);
    const timeLabel = time ? `<small class="event-time">${escapeHtml(time)}</small>` : "";
    return `
    <article class="result-card">
      <div class="result-event">
        <strong>${escapeHtml(event)}</strong>
        ${timeLabel}
      </div>
      <div class="result-finish">
        <strong class="${numericFinish && Number(finish) <= 3 ? "top-three" : ""}">${escapeHtml(position)}</strong>
      </div>
    </article>`;
  }).join("");
  const carImage = '<img src="exampleIMG.jpeg" alt="Formula Buckeyes car">';
  const specsSection = Object.keys(record.specs).length
    ? `<section class="specs-section" aria-label="Car specifications">
        <div class="section-heading"><span>CAR SPECIFICATIONS</span></div>
        ${renderSpecs(record)}
      </section>`
    : "";

  elements.panelContent.innerHTML = `
    <div class="season-data">
      <div class="season-main">
        <section class="results-section" aria-label="Competition finishes">
          <div class="section-heading"><span>COMPETITION FINISHES</span></div>
          <div class="results-grid">${resultCards}</div>
        </section>
        <div class="car-image-frame">${carImage}</div>
      </div>
      ${specsSection}
    </div>`;

  document.querySelectorAll(".year-mark").forEach((mark) => {
    const active = Number(mark.dataset.index) === currentIndex;
    mark.classList.toggle("is-current", active);
    mark.setAttribute("aria-current", active ? "date" : "false");
  });
  keepCurrentTimelineMarkVisible();
}

function keepCurrentTimelineMarkVisible() {
  const viewportHeight = elements.timelineTrack.clientHeight;
  if (!viewportHeight) return;

  const markPosition = (currentIndex + 1) * TIMELINE_STEP;
  const visibleTop = elements.timelineTrack.scrollTop + TIMELINE_STEP;
  const visibleBottom = elements.timelineTrack.scrollTop + viewportHeight - TIMELINE_STEP;
  if (markPosition < visibleTop || markPosition > visibleBottom) {
    const maxScroll = elements.timelineRail.scrollHeight - viewportHeight;
    elements.timelineTrack.scrollTop = Math.max(
      0,
      Math.min(maxScroll, markPosition - viewportHeight / 2)
    );
  }
}

function updateScrollPreview(accumulation = scrollAccumulation, threshold = CHANGE_THRESHOLD) {
  const progress = accumulation / threshold;
  elements.archivePanel.style.transform = `translateY(${-progress * 24}px)`;
  elements.archivePanel.style.opacity = String(1 - Math.abs(progress) * 0.18);
}

// Scroll has signed momentum: reversing input first cancels the existing
// movement, so a near-threshold gesture cannot immediately switch seasons.
function accumulateSeasonInput(delta) {
  if (!delta || seasonTransitioning || RECORDS.length === 0) return;
  panelEdgeAccumulation = 0;
  const nextAccumulation = scrollAccumulation + delta;
  const nextDirection = Math.sign(nextAccumulation);
  if ((nextDirection < 0 && currentIndex === 0)
    || (nextDirection > 0 && currentIndex === RECORDS.length - 1)) {
    scrollAccumulation = 0;
    updateScrollPreview();
    return;
  }

  scrollAccumulation = nextAccumulation;
  updateScrollPreview();
  if (Math.abs(scrollAccumulation) >= CHANGE_THRESHOLD) {
    transitionTo(currentIndex + Math.sign(scrollAccumulation));
  }
}

function changeSeasonAtPanelEdge(content, delta) {
  if (RECORDS.length === 0) return false;
  const direction = Math.sign(delta);
  if (!direction) return false;
  const maxScroll = content.scrollHeight - content.clientHeight;
  const hasOverflow = maxScroll > 1;
  const atEdge = !hasOverflow
    || (direction > 0 && content.scrollTop >= maxScroll - 1)
    || (direction < 0 && content.scrollTop <= 1);
  if (!atEdge) {
    scrollAccumulation = 0;
    panelEdgeAccumulation = 0;
    updateScrollPreview(0);
    return false;
  }

  scrollAccumulation = 0;
  panelEdgeAccumulation += delta;
  updateScrollPreview(panelEdgeAccumulation, PANEL_EDGE_THRESHOLD);
  if (Math.abs(panelEdgeAccumulation) >= PANEL_EDGE_THRESHOLD) {
    const nextDirection = Math.sign(panelEdgeAccumulation);
    panelEdgeAccumulation = 0;
    updateScrollPreview(0);
    transitionTo(currentIndex + nextDirection);
  }
  return true;
}

// The complete season panel leaves in the scroll direction and the next one
// enters from the opposite side.
async function transitionTo(index) {
  if (RECORDS.length === 0) return;
  const nextIndex = Math.max(0, Math.min(RECORDS.length - 1, index));
  if (nextIndex === currentIndex || seasonTransitioning) return;
  seasonTransitioning = true;
  const direction = Math.sign(nextIndex - currentIndex);
  const panel = elements.archivePanel;
  const currentTransform = getComputedStyle(panel).transform;
  const currentOpacity = getComputedStyle(panel).opacity;
  const outgoingOffset = direction > 0 ? "-100%" : "100%";
  const incomingOffset = direction > 0 ? "100%" : "-100%";
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (reducedMotion || document.hidden) {
    currentIndex = nextIndex;
    scrollAccumulation = 0;
    panelEdgeAccumulation = 0;
    panel.style.transform = "";
    panel.style.opacity = "";
    render();
    elements.panelContent.scrollTop = 0;
    seasonTransitioning = false;
    return;
  }

  panel.classList.add("is-transitioning");
  const outgoingAnimation = panel.animate([
    { opacity: currentOpacity, transform: currentTransform },
    { opacity: 0, transform: `translateY(${outgoingOffset})` }
  ], { duration: reducedMotion ? 1 : 240, easing: "ease-in", fill: "forwards" });
  await outgoingAnimation.finished;
  outgoingAnimation.cancel();

  currentIndex = nextIndex;
  scrollAccumulation = 0;
  panelEdgeAccumulation = 0;
  panel.style.transform = "";
  panel.style.opacity = "";
  render();
  elements.panelContent.scrollTop = 0;
  await panel.animate([
    { opacity: 0, transform: `translateY(${incomingOffset})` },
    { opacity: 1, transform: "translateY(0)" }
  ], { duration: reducedMotion ? 1 : 360, easing: "cubic-bezier(.2,.8,.2,1)" }).finished;

  seasonTransitioning = false;
  panel.classList.remove("is-transitioning");
}

elements.panelContent.innerHTML = `
  <div class="spec-empty">
    <strong>LOADING SEASON ARCHIVE</strong>
    <p>Reading results and vehicle specifications from the CSV file.</p>
  </div>`;
loadArchiveData().then(() => {
  const defaultIndex = SEASONS.indexOf(2026);
  currentIndex = defaultIndex >= 0 ? defaultIndex : 0;
  renderTimeline();
  render();
}, (error) => {
  console.error("Could not load the Formula Buckeyes CSV archive.", error);
  elements.panelContent.innerHTML = `
    <div class="spec-empty">
      <strong>ARCHIVE DATA COULD NOT BE LOADED</strong>
      <p>Open this page through a local web server (such as VS Code Live Server) and keep ${escapeHtml(DATA_FILE.replace("%20", " "))} beside index.html.</p>
    </div>`;
});

// Keep the browser viewport fixed; wheel distance is consumed by the season
// threshold instead of scrolling the document or an inner results panel.
document.addEventListener("wheel", (event) => {
  if (event.ctrlKey || event.metaKey) return;
  if (event.target instanceof Element && event.target.closest("#timelineTrack")) return;
  const content = event.target instanceof Element
    ? event.target.closest("#panelContent")
    : null;
  if (content) {
    if (changeSeasonAtPanelEdge(content, event.deltaY)) event.preventDefault();
    return;
  }
  event.preventDefault();
  accumulateSeasonInput(event.deltaY);
}, { passive: false });

function nearestTimelineIndex(clientY) {
  const bounds = elements.timelineTrack.getBoundingClientRect();
  const position = clientY - bounds.top + elements.timelineTrack.scrollTop;
  return Math.max(0, Math.min(
    SEASONS.length - 1,
    Math.round(position / TIMELINE_STEP) - 1
  ));
}

function showHoveredTimelineYear(index) {
  const mark = elements.timelineMarks.querySelector(`[data-index="${index}"]`);
  if (hoveredYearMark === mark) return;
  if (hoveredYearMark) hoveredYearMark.classList.remove("is-hovered");
  if (mark) mark.classList.add("is-hovered");
  hoveredYearMark = mark;
}

elements.timelineMarks.addEventListener("pointermove", (event) => {
  showHoveredTimelineYear(nearestTimelineIndex(event.clientY));
});
elements.timelineMarks.addEventListener("pointerleave", () => {
  if (hoveredYearMark) hoveredYearMark.classList.remove("is-hovered");
  hoveredYearMark = null;
});
elements.timelineMarks.addEventListener("click", (event) => {
  const mark = event.target.closest(".year-mark");
  if (!mark) return;

  // Pointer users can click anywhere near the rail; keyboard activation keeps
  // the exact year announced by the focused button.
  const index = event.detail === 0
    ? Number(mark.dataset.index)
    : nearestTimelineIndex(event.clientY);
  transitionTo(index);
});
document.querySelectorAll(".placeholder-link").forEach((link) => {
  link.addEventListener("click", (event) => event.preventDefault());
});
document.addEventListener("keydown", (event) => {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.target === elements.timelineTrack
    && ["ArrowDown", "ArrowUp", "PageDown", "PageUp"].includes(event.key)) return;
  if (event.key === "ArrowDown" || event.key === "PageDown") {
    event.preventDefault();
    accumulateSeasonInput(CHANGE_THRESHOLD / 4);
  } else if (event.key === "ArrowUp" || event.key === "PageUp") {
    event.preventDefault();
    accumulateSeasonInput(-CHANGE_THRESHOLD / 4);
  }
});

// Touch swipes contribute to the same threshold rather than skipping seasons.
document.addEventListener("touchstart", (event) => {
  touchStartY = event.changedTouches[0].clientY;
  touchStartedInTimeline = event.target instanceof Element
    && event.target.closest("#timelineTrack") !== null;
  touchStartedInDataPanel = event.target instanceof Element
    && event.target.closest("#panelContent") !== null;
  touchDataScrollTop = touchStartedInDataPanel ? elements.panelContent.scrollTop : 0;
}, { passive: true });
document.addEventListener("touchend", (event) => {
  if (touchStartY === null) return;
  const distance = touchStartY - event.changedTouches[0].clientY;
  if (Math.abs(distance) >= 35 && !touchStartedInTimeline) {
    if (touchStartedInDataPanel) {
      const content = elements.panelContent;
      const maxScroll = content.scrollHeight - content.clientHeight;
      const direction = Math.sign(distance);
      const startedAtEdge = maxScroll <= 1
        || (direction > 0 && touchDataScrollTop >= maxScroll - 1)
        || (direction < 0 && touchDataScrollTop <= 1);
      if (startedAtEdge) {
        changeSeasonAtPanelEdge(content, distance);
      } else {
        scrollAccumulation = 0;
        panelEdgeAccumulation = 0;
        updateScrollPreview(0);
      }
    } else {
      accumulateSeasonInput(distance);
    }
  }
  touchStartY = null;
  touchStartedInTimeline = false;
  touchStartedInDataPanel = false;
  touchDataScrollTop = 0;
}, { passive: true });
