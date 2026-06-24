import { z } from 'zod';
import type { ActionDefinition, ActionSource, ActionContext, ActionResult } from '@valet/sdk';

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

function calendarFetch(
  url: string,
  token: string,
  options?: RequestInit,
): Promise<Response> {
  return fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
}

// ─── Shared schema ────────────────────────────────────────────────────────────

const eventDateTimeSchema = z
  .object({
    dateTime: z
      .string()
      .optional()
      .describe(
        'RFC3339 timestamp with timezone offset, e.g. "2026-04-15T14:00:00-08:00". Use this for timed events.',
      ),
    date: z
      .string()
      .optional()
      .describe('ISO date "YYYY-MM-DD" for all-day events. Use instead of dateTime.'),
    timeZone: z
      .string()
      .optional()
      .describe('IANA timezone like "America/Los_Angeles". Optional when dateTime has an offset.'),
  })
  .refine((v) => v.dateTime || v.date, {
    message: 'Provide either dateTime (timed event) or date (all-day event).',
  });

// ─── Output Schemas (shared) ────────────────────────────────────────────────

const calendarEventDateTimeOutputSchema = {
  type: 'object',
  description: 'One of dateTime (timed) or date (all-day) is set, never both',
  properties: {
    dateTime: { type: ['string', 'null'], description: 'RFC3339 timestamp for timed events' },
    date: { type: ['string', 'null'], description: 'ISO date YYYY-MM-DD for all-day events' },
    timeZone: { type: ['string', 'null'], description: 'IANA timezone' },
  },
} satisfies Record<string, unknown>;

const calendarAttendeeOutputSchema = {
  type: 'object',
  properties: {
    email: { type: 'string' },
    responseStatus: {
      type: 'string',
      enum: ['needsAction', 'declined', 'tentative', 'accepted'],
    },
    optional: { type: 'boolean' },
  },
} satisfies Record<string, unknown>;

// Full per-event shape returned by list_events. create/update/quick-add
// return a leaner shape (id, summary, start, end, htmlLink, …).
const calendarEventListItemSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    status: { type: 'string', description: 'confirmed | tentative | cancelled' },
    summary: { type: ['string', 'null'] },
    description: { type: ['string', 'null'] },
    location: { type: ['string', 'null'] },
    start: calendarEventDateTimeOutputSchema,
    end: calendarEventDateTimeOutputSchema,
    attendees: { type: 'array', items: calendarAttendeeOutputSchema },
    organizer: { type: ['string', 'null'], description: 'Organizer email' },
    htmlLink: { type: ['string', 'null'] },
    recurringEventId: { type: ['string', 'null'], description: 'Set on instances of a recurring series' },
  },
} satisfies Record<string, unknown>;

// ─── Action Definitions ──────────────────────────────────────────────────────

const listEvents: ActionDefinition = {
  id: 'calendar.list_events',
  name: 'List Events',
  description:
    "Lists or searches Google Calendar events. Defaults to the user's primary calendar starting now. Use timeMin/timeMax (RFC3339 timestamps) to bound the window, q for free-text search, and maxResults to cap the count. Returns event IDs needed for updateEvent and deleteEvent.",
  riskLevel: 'low',
  params: z.object({
    calendarId: z
      .string()
      .optional()
      .default('primary')
      .describe('Calendar ID. Defaults to "primary" (the user\'s main calendar).'),
    q: z
      .string()
      .optional()
      .describe('Free-text search across summary, description, location, and attendees.'),
    timeMin: z
      .string()
      .optional()
      .describe(
        'Lower bound (inclusive) as RFC3339 timestamp, e.g. "2026-04-10T00:00:00-08:00". Defaults to now.',
      ),
    timeMax: z.string().optional().describe('Upper bound (exclusive) as RFC3339 timestamp.'),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(2500)
      .optional()
      .default(25)
      .describe('Maximum number of events to return (1-2500). Defaults to 25.'),
    singleEvents: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        'If true (default), expands recurring events into individual instances. Set false to receive recurring events as a single record.',
      ),
  }),
  outputSchema: {
    type: 'object',
    properties: {
      events: { type: 'array', items: calendarEventListItemSchema },
      count: { type: 'number' },
      nextPageToken: { type: ['string', 'null'], description: 'Pass back as a continuation token in a follow-up call' },
    },
  },
};

const createEvent: ActionDefinition = {
  id: 'calendar.create_event',
  name: 'Create Event',
  description:
    'Creates a new event on a Google Calendar. Supports timed events (start/end with dateTime) and all-day events (start/end with date). Set sendUpdates to email invitations to attendees.',
  riskLevel: 'medium',
  params: z.object({
    calendarId: z
      .string()
      .optional()
      .default('primary')
      .describe('Calendar ID. Defaults to "primary".'),
    summary: z.string().describe('Event title.'),
    description: z.string().optional().describe('Event description / notes.'),
    location: z.string().optional().describe('Physical address or location string.'),
    start: eventDateTimeSchema.describe('Event start. Provide dateTime or date.'),
    end: eventDateTimeSchema.describe(
      'Event end. Provide dateTime or date. For all-day events, end.date is exclusive.',
    ),
    attendees: z
      .array(
        z.object({
          email: z.string().describe('Attendee email address.'),
          optional: z.boolean().optional().describe('Mark attendee as optional.'),
        }),
      )
      .optional()
      .describe('List of attendees to invite.'),
    sendUpdates: z
      .enum(['all', 'externalOnly', 'none'])
      .optional()
      .default('none')
      .describe(
        'Whether to send email invitations: "all" sends to everyone, "externalOnly" only to non-domain attendees, "none" sends nothing (default).',
      ),
    conferenceData: z
      .boolean()
      .optional()
      .default(false)
      .describe('If true, attaches an automatically generated Google Meet link to the event.'),
  }),
  outputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      summary: { type: 'string' },
      start: calendarEventDateTimeOutputSchema,
      end: calendarEventDateTimeOutputSchema,
      htmlLink: { type: 'string' },
      hangoutLink: { type: ['string', 'null'], description: 'Set when conferenceData was requested' },
      attendees: { type: 'number', description: 'Count of attendees invited' },
      message: { type: 'string', description: 'Human-readable confirmation' },
    },
  },
};

const updateEvent: ActionDefinition = {
  id: 'calendar.update_event',
  name: 'Update Event',
  description:
    'Updates an existing Google Calendar event with PATCH semantics — only the fields you provide are changed; everything else stays the same. Common uses: reschedule (set start+end), retitle (set summary), add/remove attendees (set attendees array which fully replaces).',
  riskLevel: 'medium',
  params: z.object({
    calendarId: z
      .string()
      .optional()
      .default('primary')
      .describe('Calendar ID. Defaults to "primary".'),
    eventId: z.string().describe('The event ID to update (from list_events).'),
    summary: z.string().optional().describe('New event title.'),
    description: z.string().optional().describe('New event description.'),
    location: z.string().optional().describe('New location.'),
    start: eventDateTimeSchema.optional().describe('New start time.'),
    end: eventDateTimeSchema.optional().describe('New end time.'),
    attendees: z
      .array(
        z.object({
          email: z.string(),
          optional: z.boolean().optional(),
        }),
      )
      .optional()
      .describe('Replaces the entire attendee list. To add one, fetch the event first.'),
    sendUpdates: z
      .enum(['all', 'externalOnly', 'none'])
      .optional()
      .default('none')
      .describe('Whether to email attendees about the change.'),
  }),
  outputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      summary: { type: 'string' },
      start: calendarEventDateTimeOutputSchema,
      end: calendarEventDateTimeOutputSchema,
      htmlLink: { type: 'string' },
      updated: { type: 'string', description: 'RFC3339 last-modified timestamp' },
      message: { type: 'string' },
    },
  },
};

const deleteEvent: ActionDefinition = {
  id: 'calendar.delete_event',
  name: 'Delete Event',
  description:
    'Deletes an event from a Google Calendar. This is permanent — the event is removed, not trashed. Use sendUpdates to email cancellations to attendees.',
  riskLevel: 'high',
  params: z.object({
    calendarId: z
      .string()
      .optional()
      .default('primary')
      .describe('Calendar ID. Defaults to "primary".'),
    eventId: z.string().describe('The event ID to delete (from list_events).'),
    sendUpdates: z
      .enum(['all', 'externalOnly', 'none'])
      .optional()
      .default('none')
      .describe('Whether to email cancellation notices to attendees.'),
  }),
  outputSchema: {
    type: 'object',
    properties: {
      eventId: { type: 'string' },
      calendarId: { type: 'string' },
      message: { type: 'string' },
    },
  },
};

const quickAdd: ActionDefinition = {
  id: 'calendar.quick_add',
  name: 'Quick Add Event',
  description:
    'Creates a calendar event from a natural-language string using Google Calendar\'s quick-add parser. Examples: "Lunch with Sarah tomorrow at 12pm", "Dentist appointment next Tuesday 3-4pm", "Team standup every weekday 9am". Faster than create_event when you don\'t need attendees, descriptions, or precise control over fields.',
  riskLevel: 'medium',
  params: z.object({
    calendarId: z
      .string()
      .optional()
      .default('primary')
      .describe('Calendar ID. Defaults to "primary".'),
    text: z
      .string()
      .describe(
        'Natural-language description of the event. Google parses the title and time from this string.',
      ),
    sendUpdates: z
      .enum(['all', 'externalOnly', 'none'])
      .optional()
      .default('none')
      .describe('Whether to email invitations (rarely useful for quick add).'),
  }),
  outputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      summary: { type: 'string' },
      start: calendarEventDateTimeOutputSchema,
      end: calendarEventDateTimeOutputSchema,
      htmlLink: { type: 'string' },
      message: { type: 'string' },
    },
  },
};

const allActions: ActionDefinition[] = [listEvents, createEvent, updateEvent, deleteEvent, quickAdd];

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
      case 'calendar.list_events': {
        const p = listEvents.params.parse(params);
        const timeMin = p.timeMin ?? new Date().toISOString();
        const qs = new URLSearchParams({
          maxResults: String(p.maxResults),
          singleEvents: String(p.singleEvents),
        });
        if (timeMin) qs.set('timeMin', timeMin);
        if (p.timeMax) qs.set('timeMax', p.timeMax);
        if (p.q) qs.set('q', p.q);
        if (p.singleEvents) qs.set('orderBy', 'startTime');

        const res = await calendarFetch(
          `${CALENDAR_API}/calendars/${encodeURIComponent(p.calendarId)}/events?${qs}`,
          token,
        );
        if (!res.ok) {
          const body = await res.text();
          if (res.status === 404)
            return { success: false, error: `Calendar not found (ID: ${p.calendarId}).` };
          if (res.status === 403)
            return {
              success: false,
              error: 'Permission denied. Confirm the calendar.events scope was granted.',
            };
          return { success: false, error: `Failed to list events: ${res.status} ${body}` };
        }
        const data = (await res.json()) as {
          items?: Array<{
            id?: string;
            status?: string;
            summary?: string;
            description?: string;
            location?: string;
            start?: { dateTime?: string; date?: string; timeZone?: string };
            end?: { dateTime?: string; date?: string; timeZone?: string };
            attendees?: Array<{
              email?: string;
              responseStatus?: string;
              optional?: boolean;
            }>;
            organizer?: { email?: string };
            htmlLink?: string;
            recurringEventId?: string;
          }>;
          nextPageToken?: string;
        };
        const events = (data.items ?? []).map((event) => ({
          id: event.id,
          status: event.status,
          summary: event.summary ?? null,
          description: event.description ?? null,
          location: event.location ?? null,
          start: event.start ?? null,
          end: event.end ?? null,
          attendees:
            event.attendees?.map((a) => ({
              email: a.email,
              responseStatus: a.responseStatus,
              optional: a.optional ?? false,
            })) ?? [],
          organizer: event.organizer?.email ?? null,
          htmlLink: event.htmlLink ?? null,
          recurringEventId: event.recurringEventId ?? null,
        }));
        return { success: true, data: { events, count: events.length, nextPageToken: data.nextPageToken ?? null } };
      }

      case 'calendar.create_event': {
        const p = createEvent.params.parse(params);
        const qs = new URLSearchParams({ sendUpdates: p.sendUpdates });
        if (p.conferenceData) qs.set('conferenceDataVersion', '1');

        const requestBody: Record<string, unknown> = {
          summary: p.summary,
          start: p.start,
          end: p.end,
        };
        if (p.description !== undefined) requestBody.description = p.description;
        if (p.location !== undefined) requestBody.location = p.location;
        if (p.attendees !== undefined) requestBody.attendees = p.attendees;
        if (p.conferenceData) {
          requestBody.conferenceData = {
            createRequest: {
              requestId: `valet-${crypto.randomUUID()}`,
              conferenceSolutionKey: { type: 'hangoutsMeet' },
            },
          };
        }

        const res = await calendarFetch(
          `${CALENDAR_API}/calendars/${encodeURIComponent(p.calendarId)}/events?${qs}`,
          token,
          { method: 'POST', body: JSON.stringify(requestBody) },
        );
        if (!res.ok) {
          const body = await res.text();
          if (res.status === 404)
            return { success: false, error: `Calendar not found (ID: ${p.calendarId}).` };
          if (res.status === 403)
            return {
              success: false,
              error: 'Permission denied. Confirm the calendar.events scope was granted.',
            };
          if (res.status === 400)
            return {
              success: false,
              error: `Calendar rejected the event: ${body}. Check that start/end formats are valid RFC3339.`,
            };
          return { success: false, error: `Failed to create event: ${res.status} ${body}` };
        }
        const event = (await res.json()) as {
          id?: string;
          summary?: string;
          start?: unknown;
          end?: unknown;
          htmlLink?: string;
          hangoutLink?: string;
          attendees?: unknown[];
        };
        return {
          success: true,
          data: {
            id: event.id,
            summary: event.summary,
            start: event.start,
            end: event.end,
            htmlLink: event.htmlLink,
            hangoutLink: event.hangoutLink ?? null,
            attendees: event.attendees?.length ?? 0,
            message: `Event "${event.summary}" created.`,
          },
        };
      }

      case 'calendar.update_event': {
        const p = updateEvent.params.parse(params);
        const qs = new URLSearchParams({ sendUpdates: p.sendUpdates });

        const requestBody: Record<string, unknown> = {};
        if (p.summary !== undefined) requestBody.summary = p.summary;
        if (p.description !== undefined) requestBody.description = p.description;
        if (p.location !== undefined) requestBody.location = p.location;
        if (p.start !== undefined) requestBody.start = p.start;
        if (p.end !== undefined) requestBody.end = p.end;
        if (p.attendees !== undefined) requestBody.attendees = p.attendees;

        if (Object.keys(requestBody).length === 0) {
          return {
            success: false,
            error:
              'No fields provided to update. Pass at least one of summary, description, location, start, end, or attendees.',
          };
        }

        const res = await calendarFetch(
          `${CALENDAR_API}/calendars/${encodeURIComponent(p.calendarId)}/events/${encodeURIComponent(p.eventId)}?${qs}`,
          token,
          { method: 'PATCH', body: JSON.stringify(requestBody) },
        );
        if (!res.ok) {
          const body = await res.text();
          if (res.status === 404)
            return {
              success: false,
              error: `Event not found: ${p.eventId} on calendar ${p.calendarId}.`,
            };
          if (res.status === 403)
            return {
              success: false,
              error: 'Permission denied. Confirm the calendar.events scope was granted.',
            };
          if (res.status === 400)
            return {
              success: false,
              error: `Calendar rejected the update: ${body}.`,
            };
          return { success: false, error: `Failed to update event: ${res.status} ${body}` };
        }
        const event = (await res.json()) as {
          id?: string;
          summary?: string;
          start?: unknown;
          end?: unknown;
          htmlLink?: string;
          updated?: string;
        };
        return {
          success: true,
          data: {
            id: event.id,
            summary: event.summary,
            start: event.start,
            end: event.end,
            htmlLink: event.htmlLink,
            updated: event.updated,
            message: `Event ${event.id} updated.`,
          },
        };
      }

      case 'calendar.delete_event': {
        const p = deleteEvent.params.parse(params);
        const qs = new URLSearchParams({ sendUpdates: p.sendUpdates });

        const res = await calendarFetch(
          `${CALENDAR_API}/calendars/${encodeURIComponent(p.calendarId)}/events/${encodeURIComponent(p.eventId)}?${qs}`,
          token,
          { method: 'DELETE' },
        );
        if (!res.ok) {
          if (res.status === 404)
            return { success: false, error: `Event not found: ${p.eventId}.` };
          if (res.status === 410)
            return { success: false, error: `Event ${p.eventId} was already deleted.` };
          if (res.status === 403)
            return {
              success: false,
              error: 'Permission denied. Confirm the calendar.events scope was granted.',
            };
          const body = await res.text();
          return { success: false, error: `Failed to delete event: ${res.status} ${body}` };
        }
        return {
          success: true,
          data: {
            eventId: p.eventId,
            calendarId: p.calendarId,
            message: `Event ${p.eventId} deleted from calendar ${p.calendarId}.`,
          },
        };
      }

      case 'calendar.quick_add': {
        const p = quickAdd.params.parse(params);
        const qs = new URLSearchParams({ text: p.text, sendUpdates: p.sendUpdates });

        const res = await calendarFetch(
          `${CALENDAR_API}/calendars/${encodeURIComponent(p.calendarId)}/events/quickAdd?${qs}`,
          token,
          { method: 'POST' },
        );
        if (!res.ok) {
          const body = await res.text();
          if (res.status === 404)
            return { success: false, error: `Calendar not found (ID: ${p.calendarId}).` };
          if (res.status === 403)
            return {
              success: false,
              error: 'Permission denied. Confirm the calendar.events scope was granted.',
            };
          if (res.status === 400)
            return {
              success: false,
              error: `Calendar could not parse "${p.text}" as an event. Try a clearer time format.`,
            };
          return { success: false, error: `Failed to quick-add event: ${res.status} ${body}` };
        }
        const event = (await res.json()) as {
          id?: string;
          summary?: string;
          start?: unknown;
          end?: unknown;
          htmlLink?: string;
        };
        return {
          success: true,
          data: {
            id: event.id,
            summary: event.summary,
            start: event.start,
            end: event.end,
            htmlLink: event.htmlLink,
            message: `Event "${event.summary}" created from "${p.text}".`,
          },
        };
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
