// Notification preferences composable. Routes through
// /api/notification-preferences/*.

export type NotificationPref = {
  user_id: string
  kind: string
  email_enabled: boolean
  push_enabled: boolean
  sms_enabled: boolean
  created_at: string
  updated_at: string
}

export type UpsertPrefInput = {
  kind: string
  email_enabled?: boolean
  push_enabled?: boolean
  sms_enabled?: boolean
}

export function useNotificationPreferences() {
  async function listPrefs(): Promise<NotificationPref[]> {
    const res = await $fetch<{ data: NotificationPref[] }>('/api/notification-preferences')
    return res?.data ?? []
  }

  async function upsertPref(input: UpsertPrefInput): Promise<NotificationPref> {
    return await $fetch<NotificationPref>('/api/notification-preferences', {
      method: 'PUT',
      body: input,
    })
  }

  return { listPrefs, upsertPref }
}

// Catalog of every notification kind the system currently emits.
// Drives the settings page so we don't have to hardcode the list there
// (and so a new kind shows up in the UI by adding it here).
export const NOTIFICATION_KINDS: { value: string; label: string; description: string }[] = [
  {
    value: 'listing.shared',
    label: 'Listing shares',
    description: 'When someone shares a listing with you for co-brokering.',
  },
  {
    value: 'task.assigned',
    label: 'Task assignments',
    description: 'When someone assigns you a CRM task.',
  },
  {
    value: 'contact.note_added',
    label: 'Notes on your contacts',
    description: 'When a teammate adds a note to a contact you own.',
  },
  {
    value: 'listing.note_added',
    label: 'Notes on your listings',
    description: 'When a teammate adds a note to a listing you created.',
  },
  {
    value: 'listing.inquiry_received',
    label: 'New inquiries',
    description: 'When a public-website visitor inquires about one of your listings.',
  },
]
