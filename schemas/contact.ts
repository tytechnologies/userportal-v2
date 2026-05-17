import { z } from 'zod'

const dataUrlImage = z
  .string()
  .regex(/^data:image\/(png|jpe?g|webp|gif);base64,/, 'must be a data URL with image MIME type')
  .max(15_000_000, 'avatar payload too large')

// `.strict()` rejects unknown keys — smoke-test 2026-05-14 found
// the form was sending `phone` (no matching column) and getting a
// 200 with a populated body that silently dropped it. Strict mode
// surfaces every client/server name skew immediately.
//
// `owner_user_id` is NOT accepted from the client. The contacts
// table has `owner_user_id DEFAULT auth.uid()` (mig 20260430000002)
// + RLS scoped to that column. If we let the client set it, a stale
// or wrong UUID lands the row under someone else's ownership; RLS
// then hides it from the creating broker, and PATCH/GET both behave
// as if the row doesn't exist (P0 silent-data-loss bug).
export const contactCreateSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().nullable().optional(),
  designation: z.string().max(200).nullable().optional(),
  mobilePhone: z.string().max(50).nullable().optional(),
  homePhone: z.string().max(50).nullable().optional(),
  fbLink: z.string().max(500).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  avatarImage: dataUrlImage.optional(),
}).strict()

export type ContactCreate = z.infer<typeof contactCreateSchema>

export const contactUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  email: z.string().email().nullable().optional(),
  designation: z.string().max(200).nullable().optional(),
  mobilePhone: z.string().max(50).nullable().optional(),
  homePhone: z.string().max(50).nullable().optional(),
  fbLink: z.string().max(500).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  avatarImage: dataUrlImage.optional(),
}).strict()

export type ContactUpdate = z.infer<typeof contactUpdateSchema>

export const contactAvatarSchema = z.object({
  avatarImage: dataUrlImage,
})

export type ContactAvatar = z.infer<typeof contactAvatarSchema>
