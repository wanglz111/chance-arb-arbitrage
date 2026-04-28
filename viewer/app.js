const state = {
  autoRefresh: false,
  filters: {
    flashLoanOnly: false,
    limit: 50,
    minScore: 0,
    offset: 0,
    payoutOnly: false,
    protocol: "",
    q: "",
    routeHint: "",
    sort: "newest",
    tag: ""
  },
  refreshTimer: null,
  summary: null
};

const elements = {
  autoRefreshToggle: document.querySelector("#autoRefreshToggle"),
  averageScore: document.querySelector("#averageScore"),
  candidateList: document.querySelector("#candidateList"),
  datasetMeta: document.querySelector("#datasetMeta"),
  filterForm: document.querySelector("#filterForm"),
  flashLoanCandidates: document.querySelector("#flashLoanCandidates"),
  flashLoanOnly: document.querySelector("#flashLoanOnly"),
  limitSelect: document.querySelector("#limitSelect"),
  nextButton: document.querySelector("#nextButton"),
  pageInfo: document.querySelector("#pageInfo"),
  payoutCandidates: document.querySelector("#payoutCandidates"),
  payoutOnly: document.querySelector("#payoutOnly"),
  prevButton: document.querySelector("#prevButton"),
  protocolSelect: document.querySelector("#protocolSelect"),
  refreshButton: document.querySelector("#refreshButton"),
  resultsMeta: document.querySelector("#resultsMeta"),
  resultsTitle: document.querySelector("#resultsTitle"),
  routeHintSelect: document.querySelector("#routeHintSelect"),
  searchInput: document.querySelector("#searchInput"),
  scoreSevenNewest: document.querySelector("#scoreSevenNewest"),
  sortSelect: document.querySelector("#sortSelect"),
  tagSelect: document.querySelector("#tagSelect"),
  template: document.querySelector("#candidateTemplate"),
  totalCandidates: document.querySelector("#totalCandidates")
};

function formatAddress(value) {
  if (!value) return "-";
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatScore(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function scoreTone(value) {
  if (value >= 8) return "score-hot";
  if (value >= 6) return "score-high";
  if (value >= 4) return "score-mid";
  return "score-low";
}

function formatTimestamp(value) {
  if (!value) return "-";
  return new Date(value * 1000).toLocaleString("zh-CN", {
    day: "numeric",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "numeric",
    second: "2-digit",
    year: "numeric"
  });
}

function formatUpdatedAt(value) {
  if (!value) return "No data yet";
  return new Date(value).toLocaleString();
}

function setSelectOptions(select, items, fallbackLabel) {
  const previous = select.value;
  select.innerHTML = "";

  const fallbackOption = document.createElement("option");
  fallbackOption.value = "";
  fallbackOption.textContent = fallbackLabel;
  select.append(fallbackOption);

  for (const item of items) {
    const option = document.createElement("option");
    option.value = item.value;
    option.textContent = `${item.value} (${item.count})`;
    select.append(option);
  }

  select.value = items.some((item) => item.value === previous) ? previous : "";
}

function createChip(text, tone = "neutral") {
  const chip = document.createElement("span");
  chip.className = `chip chip-${tone}`;
  chip.textContent = text;
  return chip;
}

function appendChips(container, items, tone) {
  if (!items || items.length === 0) {
    const empty = document.createElement("span");
    empty.className = "empty-value";
    empty.textContent = "-";
    container.append(empty);
    return;
  }

  for (const item of items) {
    container.append(createChip(item, tone));
  }
}

function syncFiltersFromForm() {
  state.filters.q = elements.searchInput.value.trim();
  state.filters.tag = elements.tagSelect.value;
  state.filters.protocol = elements.protocolSelect.value;
  state.filters.routeHint = elements.routeHintSelect.value;
  state.filters.sort = elements.sortSelect.value;
  state.filters.limit = Number.parseInt(elements.limitSelect.value, 10);
  state.filters.flashLoanOnly = elements.flashLoanOnly.checked;
  state.filters.payoutOnly = elements.payoutOnly.checked;
  state.filters.minScore = elements.scoreSevenNewest.checked ? 7 : 0;

  if (elements.scoreSevenNewest.checked) {
    state.filters.sort = "newest";
    elements.sortSelect.value = "newest";
  }
}

function paramsFromFilters() {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(state.filters)) {
    if (typeof value === "boolean") {
      if (value) params.set(key, "1");
      continue;
    }

    if (value !== "" && value !== null && value !== undefined) {
      if (key === "minScore" && value === 0) continue;
      params.set(key, String(value));
    }
  }

  return params;
}

function renderSummary(summaryPayload) {
  state.summary = summaryPayload;

  const { summary, updatedAt, invalidLineCount, dataPath } = summaryPayload;
  elements.totalCandidates.textContent = formatNumber(summary.totalCandidates);
  elements.flashLoanCandidates.textContent = formatNumber(summary.flashLoanCandidates);
  elements.payoutCandidates.textContent = formatNumber(summary.payoutCandidates);
  elements.averageScore.textContent = summary.totalCandidates === 0 ? "-" : summary.averageScore.toFixed(2);
  elements.datasetMeta.textContent = `${formatUpdatedAt(updatedAt)} · invalid lines ${invalidLineCount} · ${dataPath}`;

  setSelectOptions(elements.tagSelect, summary.tags, "All tags");
  setSelectOptions(elements.protocolSelect, summary.protocols, "All protocols");
  setSelectOptions(elements.routeHintSelect, summary.routeHints, "All route hints");
}

function renderCandidate(candidate) {
  const fragment = elements.template.content.cloneNode(true);
  const card = fragment.querySelector(".candidate-card");
  const tx = fragment.querySelector(".candidate-tx");
  const scoreLine = fragment.querySelector(".score-line");
  const subtitle = fragment.querySelector(".candidate-subtitle");
  const arbiscanLink = fragment.querySelector(".arbiscan-link");
  const blocksecLink = fragment.querySelector(".blocksec-link");
  const tags = fragment.querySelector(".candidate-tags");
  const protocols = fragment.querySelector(".candidate-protocols");
  const routeHints = fragment.querySelector(".candidate-route-hints");

  tx.textContent = candidate.txHash;
  scoreLine.textContent = `score ${formatScore(candidate.score)}`;
  scoreLine.classList.add(scoreTone(candidate.score));
  card.classList.add(`card-${scoreTone(candidate.score)}`);
  subtitle.textContent = `block ${candidate.blockNumber} · txIndex ${candidate.txIndex ?? "-"} · ${formatTimestamp(candidate.timestamp)} · from ${formatAddress(candidate.from)} · to ${formatAddress(candidate.to)}`;
  arbiscanLink.href = `https://arbiscan.io/tx/${candidate.txHash}`;
  blocksecLink.href = `https://app.blocksec.com/phalcon/explorer/tx/arbitrum/${candidate.txHash}`;

  appendChips(tags, candidate.tags, "tag");
  appendChips(protocols, candidate.protocols, "protocol");
  appendChips(routeHints, candidate.routeHints, "hint");

  card.dataset.score = String(candidate.score);
  return fragment;
}

function renderCandidates(payload) {
  const { items, meta } = payload;
  elements.candidateList.innerHTML = "";

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No candidates matched the current filters.";
    elements.candidateList.append(empty);
  } else {
    for (const candidate of items) {
      elements.candidateList.append(renderCandidate(candidate));
    }
  }

  const pageStart = meta.total === 0 ? 0 : meta.offset + 1;
  const pageEnd = meta.offset + meta.returned;
  const currentPage = Math.floor(meta.offset / meta.limit) + 1;
  const totalPages = Math.max(1, Math.ceil(meta.total / meta.limit));

  elements.resultsTitle.textContent = `Candidates · ${formatNumber(meta.total)}`;
  elements.resultsMeta.textContent = `${pageStart}-${pageEnd} of ${formatNumber(meta.total)} · updated ${formatUpdatedAt(meta.updatedAt)} · invalid lines ${meta.invalidLineCount}`;
  elements.pageInfo.textContent = `Page ${currentPage} / ${totalPages}`;
  elements.prevButton.disabled = meta.offset === 0;
  elements.nextButton.disabled = meta.offset + meta.returned >= meta.total;
}

async function loadSummary() {
  const response = await fetch("/api/summary");
  if (!response.ok) {
    throw new Error(`Summary request failed: ${response.status}`);
  }

  renderSummary(await response.json());
}

async function loadCandidates() {
  const response = await fetch(`/api/candidates?${paramsFromFilters().toString()}`);
  if (!response.ok) {
    throw new Error(`Candidate request failed: ${response.status}`);
  }

  renderCandidates(await response.json());
}

async function refreshAll() {
  elements.refreshButton.disabled = true;

  try {
    await loadSummary();
    await loadCandidates();
  } catch (error) {
    elements.candidateList.innerHTML = "";
    const failure = document.createElement("div");
    failure.className = "empty-state";
    failure.textContent = String(error instanceof Error ? error.message : error);
    elements.candidateList.append(failure);
  } finally {
    elements.refreshButton.disabled = false;
  }
}

function setAutoRefresh(enabled) {
  state.autoRefresh = enabled;

  if (state.refreshTimer) {
    window.clearInterval(state.refreshTimer);
    state.refreshTimer = null;
  }

  if (enabled) {
    state.refreshTimer = window.setInterval(() => {
      void refreshAll();
    }, 15_000);
  }
}

elements.refreshButton.addEventListener("click", () => {
  void refreshAll();
});

elements.autoRefreshToggle.addEventListener("change", () => {
  setAutoRefresh(elements.autoRefreshToggle.checked);
});

elements.filterForm.addEventListener("change", () => {
  syncFiltersFromForm();
  state.filters.offset = 0;
  void loadCandidates();
});

let searchDebounce = null;
elements.searchInput.addEventListener("input", () => {
  if (searchDebounce) {
    window.clearTimeout(searchDebounce);
  }

  searchDebounce = window.setTimeout(() => {
    syncFiltersFromForm();
    state.filters.offset = 0;
    void loadCandidates();
  }, 250);
});

elements.prevButton.addEventListener("click", () => {
  state.filters.offset = Math.max(0, state.filters.offset - state.filters.limit);
  void loadCandidates();
});

elements.nextButton.addEventListener("click", () => {
  state.filters.offset += state.filters.limit;
  void loadCandidates();
});

void refreshAll();
