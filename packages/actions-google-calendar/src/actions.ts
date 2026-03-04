import { z } from 'zod';
import type { ActionDefinition, ActionSource, ActionContext, ActionResult } from '@valet/sdk';
import { calendarFetch } from './api.js';

// ─── Internal Types ──────────────────────────────────────────────────────────

interface GoogleEvent {
  id: string;
  status: 'confirmed' | 'tentative' | 'cancelled';
  htmlLink: string;
  summary?: string;
  description?: string;
  location?: string;
  creator?: { email: string; displayName?: string };
  organizer?: { email: string; displayName?: string };
  start: { date?: string; dateTime?: string; timeZone?: string };
  end: { date?: string; dateTime?: string; timeZone?: string };
  recurrence?: string[];
  attendees?: Array<{
    email: string;
    displayName?: string;
    responseStatus: string;
    organizer?: boolean;
    self?: boolean;
    optional?: boolean;
  }>;
  conferenceData?: {
    entryPoints?: Array<{ entryPointType: string; uri: string }>;
  };
  created: string;
  updated: string;
}

interface GoogleCalendar {
  id: string;
  summary: string;
  description?: string;
  timeZone: string;
  primary?: boolean;
  accessRole: string;
}

interface CalendarEvent {
  id: string;
  calendarId: string;
  title: string;
  description?: string;
  location?: string;
  start: Date;
  end: Date;
  isAllDay: boolean;
  timeZone?: string;
  attendees: Array<{ email: string; name?: string; status: string; isOrganizer: boolean }>;
  organizer?: { email: string; name?: string };
  meetingLink?: string;
  recurrence?: string[];
  status: string;
  htmlLink: string;
  createdAt: Date;
  updatedAt: Date;
}

function parseEvent(event: GoogleEvent, calendarId: string): CalendarEvent {
  const isAllDay = !!event.start.date;
  const start = isAllDay ? new Date(event.start.date!) : new Date(event.start.dateTime!);
  const end = isAllDay ? new Date(event.end.date!) : new Date(event.end.dateTime!);
  const meetingLink = event.conferenceData?.entryPoints?.find(
    (e) => e.entryPointType === 'video',
  )?.uri;

  return {
    id: event.id,
    calendarId,
    title: event.summary || '(No title)',
    description: event.description,
    location: event.location,
    start,
    end,
    isAllDay,
    timeZone: event.start.timeZone || event.end.timeZone,
    attendees: (event.attendees || []).map((a) => ({
      email: a.email,
      name: a.displayName,
      status: a.responseStatus,
      isOrganizer: a.organizer || false,
    })),
    organizer: event.organizer
      ? { email: event.organizer.email, name: event.organizer.displayName }
      : undefined,
    meetingLink,
    recurrence: event.recurrence,
    status: event.status,
    htmlLink: event.htmlLink,
    createdAt: new Date(event.created),
    updatedAt: new Date(event.updated),
  };
}

function buildEventBody(options: {
  title: string;
  description?: string;
  location?: string;
  start: string;
  end: string;
  isAllDay?: boolean;
  timeZone?: string;
  attendees?: Array<{ email: string; optional?: boolean }>;
  recurrence?: string[];
  conferenceData?: { createRequest?: { requestId: string } };
  reminders?: { useDefault?: boolean; overrides?: Array<{ method: string; minutes: number }> };
}): Record<string, unknown> {
  const body: Record<string, unknown> = { summary: options.title };
  if (options.description) body.description = options.description;
  if (options.location) body.location = options.location;

  const formatDT = (dt: string, allDay: boolean) => {
    const date = new Date(dt);
    if (allDay) return { date: date.toISOString().split('T')[0] };
    return { dateTime: date.toISOString(), timeZone: options.timeZone || 'UTC' };
  };

  body.start = formatDT(options.start, options.isAllDay || false);
  body.end = formatDT(options.end, options.isAllDay || false);

  if (options.attendees?.length) {
    body.attendees = options.attendees.map((a) => ({ email: a.email, optional: a.optional || false }));
  }
  if (options.conferenceData) body.conferenceData = options.conferenceData;
  if (options.reminders) body.reminders = options.reminders;
  if (options.recurrence) body.recurrence = options.recurrence;

  return body;
}

// ─── Action Definitions ──────────────────────────────────────────────────────

const listCalendars: ActionDefinition = {
  id: 'calendar.list_calendars',
  name: 'List Calendars',
  description: 'List all calendars the user has access to',
  riskLevel: 'low',
  params: z.object({}),
};

const getCalendar: ActionDefinition = {
  id: 'calendar.get_calendar',
  name: 'Get Calendar',
  description: 'Get a specific calendar by ID',
  riskLevel: 'low',
  params: z.object({ calendarId: z.string().optional().default('primary') }),
};

const listEvents: ActionDefinition = {
  id: 'calendar.list_events',
  name: 'List Events',
  description: 'List events from a calendar',
  riskLevel: 'low',
  params: z.object({
    calendarId: z.string().optional().default('primary'),
    timeMin: z.string().optional().describe('ISO 8601 date-time'),
    timeMax: z.string().optional().describe('ISO 8601 date-time'),
    maxResults: z.number().int().min(1).max(250).optional(),
    query: z.string().optional(),
  }),
};

const getEvent: ActionDefinition = {
  id: 'calendar.get_event',
  name: 'Get Event',
  description: 'Get a specific event by ID',
  riskLevel: 'low',
  params: z.object({
    eventId: z.string(),
    calendarId: z.string().optional().default('primary'),
  }),
};

const createEvent: ActionDefinition = {
  id: 'calendar.create_event',
  name: 'Create Event',
  description: 'Create a new calendar event',
  riskLevel: 'medium',
  params: z.object({
    calendarId: z.string().optional().default('primary'),
    title: z.string(),
    description: z.string().optional(),
    location: z.string().optional(),
    start: z.string().describe('ISO 8601 date-time'),
    end: z.string().describe('ISO 8601 date-time'),
    isAllDay: z.boolean().optional(),
    timeZone: z.string().optional(),
    attendees: z.array(z.object({ email: z.string(), optional: z.boolean().optional() })).optional(),
    sendUpdates: z.enum(['all', 'externalOnly', 'none']).optional(),
    recurrence: z.array(z.string()).optional(),
  }),
};

const updateEvent: ActionDefinition = {
  id: 'calendar.update_event',
  name: 'Update Event',
  description: 'Update an existing calendar event',
  riskLevel: 'medium',
  params: z.object({
    eventId: z.string(),
    calendarId: z.string().optional().default('primary'),
    title: z.string().optional(),
    description: z.string().optional(),
    location: z.string().optional(),
    start: z.string().optional(),
    end: z.string().optional(),
    isAllDay: z.boolean().optional(),
    timeZone: z.string().optional(),
    attendees: z.array(z.object({ email: z.string(), optional: z.boolean().optional() })).optional(),
    sendUpdates: z.enum(['all', 'externalOnly', 'none']).optional(),
  }),
};

const deleteEvent: ActionDefinition = {
  id: 'calendar.delete_event',
  name: 'Delete Event',
  description: 'Delete a calendar event',
  riskLevel: 'high',
  params: z.object({
    eventId: z.string(),
    calendarId: z.string().optional().default('primary'),
    sendUpdates: z.enum(['all', 'externalOnly', 'none']).optional().default('all'),
  }),
};

const quickAdd: ActionDefinition = {
  id: 'calendar.quick_add',
  name: 'Quick Add Event',
  description: 'Create an event from natural language text',
  riskLevel: 'medium',
  params: z.object({
    text: z.string().describe('Natural language event description'),
    calendarId: z.string().optional().default('primary'),
  }),
};

const respondToEvent: ActionDefinition = {
  id: 'calendar.respond_to_event',
  name: 'Respond to Event',
  description: 'RSVP to an event invitation',
  riskLevel: 'medium',
  params: z.object({
    eventId: z.string(),
    response: z.enum(['accepted', 'declined', 'tentative']),
    calendarId: z.string().optional().default('primary'),
  }),
};

const queryFreeBusy: ActionDefinition = {
  id: 'calendar.query_freebusy',
  name: 'Query Free/Busy',
  description: 'Query free/busy information for calendars',
  riskLevel: 'low',
  params: z.object({
    timeMin: z.string().describe('ISO 8601 date-time'),
    timeMax: z.string().describe('ISO 8601 date-time'),
    calendars: z.array(z.string()).optional(),
  }),
};

const findAvailableSlots: ActionDefinition = {
  id: 'calendar.find_available_slots',
  name: 'Find Available Slots',
  description: 'Find available time slots across calendars',
  riskLevel: 'low',
  params: z.object({
    duration: z.number().int().describe('Duration in minutes'),
    timeMin: z.string().describe('ISO 8601 date-time'),
    timeMax: z.string().describe('ISO 8601 date-time'),
    calendars: z.array(z.string()).optional(),
  }),
};

const allActions: ActionDefinition[] = [
  listCalendars,
  getCalendar,
  listEvents,
  getEvent,
  createEvent,
  updateEvent,
  deleteEvent,
  quickAdd,
  respondToEvent,
  queryFreeBusy,
  findAvailableSlots,
];

// ─── Action Execution ────────────────────────────────────────────────────────

async function executeAction(
  actionId: string,
  params: unknown,
  ctx: ActionContext,
): Promise<ActionResult> {
  const token = ctx.credentials.access_token || '';
  if (!token) return { success: false, error: 'Missing access token' };

  try {
    switch (actionId) {
      case 'calendar.list_calendars': {
        listCalendars.params.parse(params);
        const calendars: GoogleCalendar[] = [];
        let pageToken: string | undefined;

        do {
          const qs = new URLSearchParams({ maxResults: '250' });
          if (pageToken) qs.set('pageToken', pageToken);
          const res = await calendarFetch(`/users/me/calendarList?${qs}`, token);
          if (!res.ok) return { success: false, error: `Failed: ${res.status}` };
          const data = (await res.json()) as { items: GoogleCalendar[]; nextPageToken?: string };
          calendars.push(...(data.items || []));
          pageToken = data.nextPageToken;
        } while (pageToken);

        return { success: true, data: calendars };
      }

      case 'calendar.get_calendar': {
        const { calendarId } = getCalendar.params.parse(params);
        const res = await calendarFetch(`/calendars/${encodeURIComponent(calendarId)}`, token);
        if (!res.ok) return { success: false, error: `Failed: ${res.status}` };
        return { success: true, data: await res.json() };
      }

      case 'calendar.list_events': {
        const p = listEvents.params.parse(params);
        const qs = new URLSearchParams({
          maxResults: String(p.maxResults || 50),
          singleEvents: 'true',
          orderBy: 'startTime',
        });
        if (p.timeMin) qs.set('timeMin', p.timeMin);
        if (p.timeMax) qs.set('timeMax', p.timeMax);
        if (p.query) qs.set('q', p.query);

        const res = await calendarFetch(
          `/calendars/${encodeURIComponent(p.calendarId)}/events?${qs}`,
          token,
        );
        if (!res.ok) return { success: false, error: `Failed: ${res.status}` };
        const data = (await res.json()) as { items: GoogleEvent[] };
        return {
          success: true,
          data: (data.items || []).map((e) => parseEvent(e, p.calendarId)),
        };
      }

      case 'calendar.get_event': {
        const { eventId, calendarId } = getEvent.params.parse(params);
        const res = await calendarFetch(
          `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
          token,
        );
        if (!res.ok) return { success: false, error: `Failed: ${res.status}` };
        const event = (await res.json()) as GoogleEvent;
        return { success: true, data: parseEvent(event, calendarId) };
      }

      case 'calendar.create_event': {
        const p = createEvent.params.parse(params);
        const qs = new URLSearchParams();
        if (p.sendUpdates) qs.set('sendUpdates', p.sendUpdates);

        const body = buildEventBody(p);
        const res = await calendarFetch(
          `/calendars/${encodeURIComponent(p.calendarId)}/events?${qs}`,
          token,
          { method: 'POST', body: JSON.stringify(body) },
        );
        if (!res.ok) return { success: false, error: `Failed: ${res.status}` };
        const event = (await res.json()) as GoogleEvent;
        return { success: true, data: parseEvent(event, p.calendarId) };
      }

      case 'calendar.update_event': {
        const p = updateEvent.params.parse(params);
        const qs = new URLSearchParams();
        if (p.sendUpdates) qs.set('sendUpdates', p.sendUpdates);

        // Get existing event to merge
        const existingRes = await calendarFetch(
          `/calendars/${encodeURIComponent(p.calendarId)}/events/${encodeURIComponent(p.eventId)}`,
          token,
        );
        if (!existingRes.ok) return { success: false, error: `Event not found: ${existingRes.status}` };
        const existing = (await existingRes.json()) as GoogleEvent;
        const existingParsed = parseEvent(existing, p.calendarId);

        const body = buildEventBody({
          title: p.title ?? existingParsed.title,
          description: p.description ?? existingParsed.description,
          location: p.location ?? existingParsed.location,
          start: p.start ?? existingParsed.start.toISOString(),
          end: p.end ?? existingParsed.end.toISOString(),
          isAllDay: p.isAllDay ?? existingParsed.isAllDay,
          timeZone: p.timeZone ?? existingParsed.timeZone,
          attendees: p.attendees ?? existingParsed.attendees.map((a) => ({ email: a.email })),
          recurrence: existingParsed.recurrence,
        });

        const res = await calendarFetch(
          `/calendars/${encodeURIComponent(p.calendarId)}/events/${encodeURIComponent(p.eventId)}?${qs}`,
          token,
          { method: 'PUT', body: JSON.stringify(body) },
        );
        if (!res.ok) return { success: false, error: `Failed: ${res.status}` };
        const event = (await res.json()) as GoogleEvent;
        return { success: true, data: parseEvent(event, p.calendarId) };
      }

      case 'calendar.delete_event': {
        const { eventId, calendarId, sendUpdates } = deleteEvent.params.parse(params);
        const qs = new URLSearchParams({ sendUpdates });
        const res = await calendarFetch(
          `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?${qs}`,
          token,
          { method: 'DELETE' },
        );
        if (!res.ok && res.status !== 410) return { success: false, error: `Failed: ${res.status}` };
        return { success: true };
      }

      case 'calendar.quick_add': {
        const { text, calendarId } = quickAdd.params.parse(params);
        const qs = new URLSearchParams({ text });
        const res = await calendarFetch(
          `/calendars/${encodeURIComponent(calendarId)}/events/quickAdd?${qs}`,
          token,
          { method: 'POST' },
        );
        if (!res.ok) return { success: false, error: `Failed: ${res.status}` };
        const event = (await res.json()) as GoogleEvent;
        return { success: true, data: parseEvent(event, calendarId) };
      }

      case 'calendar.respond_to_event': {
        const { eventId, response, calendarId } = respondToEvent.params.parse(params);
        const getRes = await calendarFetch(
          `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
          token,
        );
        if (!getRes.ok) return { success: false, error: `Event not found: ${getRes.status}` };

        const event = (await getRes.json()) as GoogleEvent;
        const attendees = event.attendees?.map((a) =>
          a.self ? { ...a, responseStatus: response } : a,
        );

        const patchRes = await calendarFetch(
          `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
          token,
          { method: 'PATCH', body: JSON.stringify({ attendees }) },
        );
        if (!patchRes.ok) return { success: false, error: `Failed: ${patchRes.status}` };
        return { success: true };
      }

      case 'calendar.query_freebusy': {
        const p = queryFreeBusy.params.parse(params);
        const res = await calendarFetch('/freeBusy', token, {
          method: 'POST',
          body: JSON.stringify({
            timeMin: p.timeMin,
            timeMax: p.timeMax,
            items: (p.calendars || ['primary']).map((id: string) => ({ id })),
          }),
        });
        if (!res.ok) return { success: false, error: `Failed: ${res.status}` };

        const data = (await res.json()) as {
          calendars: Record<string, { busy: Array<{ start: string; end: string }> }>;
        };

        const results = Object.entries(data.calendars || {}).map(([calendar, info]) => ({
          calendar,
          busy: (info.busy || []).map((b) => ({ start: new Date(b.start), end: new Date(b.end) })),
        }));
        return { success: true, data: results };
      }

      case 'calendar.find_available_slots': {
        const p = findAvailableSlots.params.parse(params);
        // Query free/busy first
        const fbRes = await calendarFetch('/freeBusy', token, {
          method: 'POST',
          body: JSON.stringify({
            timeMin: p.timeMin,
            timeMax: p.timeMax,
            items: (p.calendars || ['primary']).map((id: string) => ({ id })),
          }),
        });
        if (!fbRes.ok) return { success: false, error: `Failed: ${fbRes.status}` };

        const fbData = (await fbRes.json()) as {
          calendars: Record<string, { busy: Array<{ start: string; end: string }> }>;
        };

        const allBusy = Object.values(fbData.calendars || {})
          .flatMap((info) => info.busy)
          .map((b) => ({ start: new Date(b.start), end: new Date(b.end) }))
          .sort((a, b) => a.start.getTime() - b.start.getTime());

        const slots: Array<{ start: Date; end: Date }> = [];
        let current = new Date(p.timeMin);
        const endTime = new Date(p.timeMax);
        const durationMs = p.duration * 60 * 1000;

        for (const busy of allBusy) {
          if (busy.start.getTime() - current.getTime() >= durationMs) {
            slots.push({ start: current, end: busy.start });
          }
          if (busy.end > current) current = busy.end;
        }

        if (endTime.getTime() - current.getTime() >= durationMs) {
          slots.push({ start: current, end: endTime });
        }

        return { success: true, data: slots };
      }

      default:
        return { success: false, error: `Unknown action: ${actionId}` };
    }
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

// ─── Export ──────────────────────────────────────────────────────────────────

export const googleCalendarActions: ActionSource = {
  listActions: () => allActions,
  execute: executeAction,
};
