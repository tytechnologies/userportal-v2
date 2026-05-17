// Area / City types were renamed in ~/types; treat as `any` here since
// this helper does property-bag access and doesn't depend on the
// structural shape.
import type { Division, Property, Type } from '~/types'
type Area = any
type City = any

export function createPropertySlug(property: Property): string {
  const divisionSegment = property['division']['slug'].substring(0, 1)
  const citySegment = property['city']['slug']
  const areaSegment =
    property['area'] !== null ? `-${property['area']['slug']}` : ''
  const buildingSegment =
    property['building'] !== null ? `-${property['building']['slug']}` : ''

  return `${citySegment}${areaSegment}${buildingSegment}-r${divisionSegment}-${property['id']}`
}

export function createDivisionCategorySlug(
  division: Division,
  category: string
): string {
  return `${division['slug']}-property-${category.toLowerCase()}`
}

export function createTypeCategorySlug(
  division: Division,
  category: string
): string {
  return `${division['slug']}-${category.toLowerCase()}`
}

export function createDivisionTypeCategorySlug(
  division: Division,
  type: Type,
  category: string
): string {
  const segments = []

  if (!!division) {
    segments.push(division['slug'])
    segments.push('property')
  }
  if (!!type) {
    segments.push(type['slug'])
  }
  if (!!category) {
    segments.push(category.toLowerCase())
  }

  return segments.join('-')
}

export function createDivisionTypeCategorySlugForArea(
  division: Division,
  city: City,
  area: Area,
  type: Type,
  category: string
): string {
  return `${createDivisionTypeCategorySlug(division, type, category)}-${
    city['slug']
  }/${area['slug']}`
}
