import type { StringMappingType } from "typescript"
import type { InferType } from "yup"

export interface Notification {
  id: number // Example: Assuming id is a number
  property_id: string
  message: string
  date: string
  is_read: boolean
  // Add other properties as needed
}

export interface Property {
  id: number
  division: {
    slug: string
  }
  city: {
    slug: string
  }
  area: {
    slug: string | null
  }
  building: {
    slug: string | null
  }
}

export interface Division {
  slug: string
}

export interface Type {
  slug: string
}

export { ListingRawSchema, ListingColumnsSchema, ListingImagesSchema } from './listingTypes'