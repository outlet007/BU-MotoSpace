function parsePositiveInt(value, fallback = 1) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clampPage(page, totalPages) {
  if (!totalPages || totalPages < 1) return 1;
  return Math.min(Math.max(page, 1), totalPages);
}

function buildPaginationItems(currentPage, totalPages, siblingCount = 2) {
  if (!totalPages || totalPages <= 1) return [];

  const pages = new Set([1, totalPages]);
  const start = Math.max(1, currentPage - siblingCount);
  const end = Math.min(totalPages, currentPage + siblingCount);

  for (let page = start; page <= end; page += 1) {
    pages.add(page);
  }

  const sortedPages = Array.from(pages).sort((a, b) => a - b);
  const items = [];
  let previousPage = 0;

  sortedPages.forEach(page => {
    if (previousPage && page - previousPage > 1) {
      items.push({ type: 'ellipsis', key: `ellipsis-${previousPage}-${page}` });
    }
    items.push({ type: 'page', page });
    previousPage = page;
  });

  return items;
}

module.exports = {
  parsePositiveInt,
  clampPage,
  buildPaginationItems,
};
