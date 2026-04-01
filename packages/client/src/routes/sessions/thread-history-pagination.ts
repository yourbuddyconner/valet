export function getThreadHistoryPages(currentPage: number, totalPages: number): number[] {
  if (totalPages <= 0) return [];

  const windowSize = 5;
  const halfWindow = Math.floor(windowSize / 2);
  let start = Math.max(1, currentPage - halfWindow);
  let end = Math.min(totalPages, start + windowSize - 1);

  start = Math.max(1, end - windowSize + 1);

  const pages: number[] = [];
  for (let page = start; page <= end; page++) {
    pages.push(page);
  }
  return pages;
}
