import { H3Event } from 'h3'
import { serverSupabaseUser } from '../utils/sbUser'

export const requireAuth = async (event: H3Event) => {
  const user = await serverSupabaseUser(event)
  
  if (!user) {
    throw createError({
      statusCode: 401,
      message: 'Unauthorized access. Please login.'
    })
  }

  // Add user to event context for later use in controllers
  event.context.user = user
  
  return user
}
