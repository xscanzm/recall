export function shouldRollOverTodayDate(
  selectedDateKey: string,
  currentDateKey: string,
  followingToday: boolean
): boolean {
  return followingToday && selectedDateKey < currentDateKey;
}

export function isCurrentTodayPageRequest(
  requestId: number,
  latestRequestId: number,
  requestedDateKey: string,
  selectedDateKey: string
): boolean {
  return requestId === latestRequestId && requestedDateKey === selectedDateKey;
}
