/** Today's meetings via Graph /me/calendarview — with online-meeting join URLs. */
import { getAccessToken } from "./auth.ts";

export interface Meeting {
  subject: string;
  start: string; // ISO
  end: string; // ISO
  joinUrl?: string;
  isOnline: boolean;
}

export async function listTodayMeetings(days = 7): Promise<Meeting[]> {
  const token = await getAccessToken();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(startOfDay.getTime() + days * 24 * 60 * 60 * 1000);

  const url =
    `https://graph.microsoft.com/v1.0/me/calendarview` +
    `?startDateTime=${startOfDay.toISOString()}` +
    `&endDateTime=${endOfDay.toISOString()}` +
    `&$top=50&$orderby=start/dateTime`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`calendarview ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as any;

  return (json.value ?? [])
    .filter((e: any) => !e.isCancelled)
    .map((e: any) => ({
      subject: e.subject ?? "(no title)",
      start: e.start?.dateTime ?? "",
      end: e.end?.dateTime ?? "",
      joinUrl: e.onlineMeeting?.joinUrl ?? undefined,
      isOnline: !!e.isOnlineMeeting,
    }));
}
