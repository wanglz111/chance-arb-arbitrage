const state = {
  autoRefresh: false,
  filters: {
    flashLoanOnly: false,
    limit: 50,
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
  protocolChips: document.querySelector("#protocolChips"),
  protocolSelect: document.querySelector("#protocolSelect"),
  refreshButton: document.querySelector("#refreshButton"),
  resultsMeta: document.querySelector("#resultsMeta"),
  resultsTitle: document.querySelector("#resultsTitle"),
  routeHintSelect: document.querySelector("#routeHintSelect"),
  searchInput: document.querySelector("#searchInput"),
  sortSelect: document.querySelector("#sortSelect"),
  tagChips: document.querySelector("#tagChips"),
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

function formatTimestamp(value) {
  if (!value) return "-";
  return new Date(value * 1000).toLocaleString();
}

function formatUpdatedAt(value) {
  if (!value) return "No data yet";
  return new Date(value).toLocaleString();
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
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

function createFilterChip(item, type) {
  const button = document.createElement("button");
  button.className = "chip-button";
  button.type = "button";
  button.textContent = `${item.value} (${item.count})`;
  button.addEventListener("click", () => {
    state.filters.offset = 0;

    if (type === "tag") {
      state.filters.tag = item.value;
      elements.tagSelect.value = item.value;
    } else {
      state.filters.protocol = item.value;
      elements.protocolSelect.value = item.value;
    }

    void loadCandidates();
  });
  return button;
}

function setChipBar(container, items, type) {
  container.innerHTML = "";
  for (const item of items.slice(0, 8)) {
    container.append(createFilterChip(item, type));
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
}

function paramsFromFilters() {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(state.filters)) {
    if (typeof value === "boolean") {
      if (value) params.set(key, "1");
      continue;
    }

    if (value !== "" && value !== null && value !== undefined) {
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
  setChipBar(elements.tagChips, summary.tags, "tag");
  setChipBar(elements.protocolChips, summary.protocols, "protocol");
}

function renderFlashLoan(item) {
  const line = document.createElement("div");
  line.className = "stack-card";
  line.innerHTML = `
    <strong>${item.protocol}</strong>
    <span>${formatAddress(item.asset)} · amount ${item.amountWei}</span>
    <span>callback ${item.callback}</span>
    <span>receiver ${formatAddress(item.receiver)} · caller ${formatAddress(item.caller)}</span>
  `;
  return line;
}

function renderPayout(item) {
  const line = document.createElement("div");
  line.className = "stack-card";
  line.innerHTML = `
    <strong>${formatAddress(item.recipient)}</strong>
    <span>token ${formatAddress(item.token)}</span>
    <span>net ${item.netAmountWei}</span>
  `;
  return line;
}

function renderCandidate(candidate) {
  const fragment = elements.template.content.cloneNode(true);
  const card = fragment.querySelector(".candidate-card");
  const tx = fragment.querySelector(".candidate-tx");
  const scoreBadge = fragment.querySelector(".score-badge");
  const subtitle = fragment.querySelector(".candidate-subtitle");
  const link = fragment.querySelector(".external-link");
  const tags = fragment.querySelector(".candidate-tags");
  const protocols = fragment.querySelector(".candidate-protocols");
  const routeHints = fragment.querySelector(".candidate-route-hints");
  const routeSection = fragment.querySelector(".route-hints-section");
  const flashLoanSection = fragment.querySelector(".flash-loans-section");
  const flashLoans = fragment.querySelector(".candidate-flash-loans");
  const payoutsSection = fragment.querySelector(".payouts-section");
  const payouts = fragment.querySelector(".candidate-payouts");
  const evidenceSection = fragment.querySelector(".evidence-section");
  const evidenceList = fragment.querySelector(".evidence-list");
  const rawJson = fragment.querySelector(".raw-json");

  tx.textContent = `${candidate.txHash.slice(0, 12)}...${candidate.txHash.slice(-8)}`;
  scoreBadge.textContent = `score ${candidate.score}`;
  subtitle.textContent = `block ${candidate.blockNumber} · txIndex ${candidate.txIndex ?? "-"} · ${formatTimestamp(candidate.timestamp)} · from ${formatAddress(candidate.from)} · to ${formatAddress(candidate.to)}`;
  link.href = `https://arbiscan.io/tx/${candidate.txHash}`;

  for (const tag of candidate.tags) {
    tags.append(createChip(tag, "tag"));
  }

  for (const protocol of candidate.protocols) {
    protocols.append(createChip(protocol, "protocol"));
  }

  if (candidate.routeHints.length === 0) {
    routeSection.hidden = true;
  } else {
    for (const hint of candidate.routeHints) {
      routeHints.append(createChip(hint, "hint"));
    }
  }

  if (candidate.flashLoans.length === 0) {
    flashLoanSection.hidden = true;
  } else {
    for (const item of candidate.flashLoans) {
      flashLoans.append(renderFlashLoan(item));
    }
  }

  if (candidate.payouts.length === 0) {
    payoutsSection.hidden = true;
  } else {
    for (const item of candidate.payouts) {
      payouts.append(renderPayout(item));
    }
  }

  if (candidate.evidence.length === 0) {
    evidenceSection.hidden = true;
  } else {
    for (const evidence of candidate.evidence) {
      const li = document.createElement("li");
      li.textContent = evidence;
      evidenceList.append(li);
    }
  }

  rawJson.innerHTML = escapeHtml(JSON.stringify(candidate, null, 2));
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
