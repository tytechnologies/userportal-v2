import axios from 'axios'
import { defineStore } from 'pinia'
import type { InferType } from 'yup'
import { ListingRawSchema, ListingColumnsSchema } from '~/types'
import ListingService from '~/services/listing.services'
import { deleteImages } from '~/services/listings/deleteImages'
import {
  getCityName,
  getCitySlug,
  getBarangayName,
  getContactName,
  getContactEmail,
} from '~/utils/listing-display'

type ListingRaw = InferType<typeof ListingRawSchema>
type ListingColumns = InferType<typeof ListingColumnsSchema>

export const fetchListingsEnded = ref(true)

export const useJustCreatedListingStore = defineStore('justCreatedListing', () => {
    const justCreatedListings = ref<ListingColumns[]>([])

    function pushJustCreatedListing(listing: ListingColumns) {
        justCreatedListings.value.push(listing)
    }

    return { justCreatedListings, pushJustCreatedListing }
})

export const useListingsRawAtom = defineStore('listingsRaw', () => {
    const listings = reactive<ListingRaw[]>([])

    function pushListing(listing: ListingRaw) {
        listings.push(listing)
        localStorage.removeItem(`tempListing-${listing.listing_id}`)
    }

    function clearListings() {
        listings.length = 0
    }

    return { listings, pushListing, clearListings }
})

export const useListingColumnsAtom = defineStore('listingColumns', () => {
    const listingColumnsData = reactive<ListingColumns[]>([])
    
    // Helper function to get column visibility from localStorage
    function getColumnVisibilityFromStorage(columnName: string): boolean {
        if (import.meta.client) {
            try {
                const stored = localStorage.getItem('listing_column_visibility_preferences')
                if (stored) {
                    const preferences = JSON.parse(stored)
                    if (columnName in preferences) {
                        return preferences[columnName]
                    }
                }
            } catch (e) {
                console.error('Error reading column preferences from storage:', e)
            }
        }
        // Default to true if not found
        return true
    }

    const listingColumnsArray = reactive<any[]>([
        {
            column_name: 'Listing',
            visible: getColumnVisibilityFromStorage('Listing'),
            sortable_keys: ['title'],
            hideable: false
        }, {
            column_name: 'Price',
            visible: getColumnVisibilityFromStorage('Price'),
            sortable_keys: ['sale_price', 'rent_price'],
            hideable: true
        }, {
            column_name: 'P/Sqm',
            visible: getColumnVisibilityFromStorage('P/Sqm'),
            sortable_keys: ['sale_price_per_sqm', 'rent_price_per_sqm'],
            hideable: true
        }, {
            column_name: 'Cond.',
            visible: getColumnVisibilityFromStorage('Condition'),
            sortable_keys: ['value'],
            hideable: true
        }, {
            column_name: 'City',
            visible: getColumnVisibilityFromStorage('City'),
            sortable_keys: ['value'],
            hideable: true
        }, {
            column_name: 'Availability',
            visible: getColumnVisibilityFromStorage('Availability'),
            sortable_keys: ['value'],
            hideable: true
        },
        {
            column_name: 'Des.',
            visible: getColumnVisibilityFromStorage('Designation'),
            sortable_keys: ['value'],
            hideable: true
        }, {
            column_name: 'Contact',
            visible: getColumnVisibilityFromStorage('Contact'),
            sortable_keys: ['name'],
            hideable: true
        }, {
            column_name: 'Bedrooms',
            icon: 'bed',
            visible: getColumnVisibilityFromStorage('Bedrooms'),
            sortable_keys: ['value'],
            hideable: true
        }, {
            column_name: 'Bathrooms',
            icon: 'shower',
            visible: getColumnVisibilityFromStorage('Bathrooms'),
            sortable_keys: ['value'],
            hideable: true
        }, {
            column_name: 'F.A',
            visible: getColumnVisibilityFromStorage('Floor Area'),
            sortable_keys: ['value'],
            hideable: true
        }, {
            column_name: 'L.A',
            visible: getColumnVisibilityFromStorage('Lot Area'),
            sortable_keys: ['value'],
            hideable: true
        }, {
            column_name: 'Parking Spaces',
            icon: 'square-parking',
            visible: getColumnVisibilityFromStorage('Parking Spaces'),
            sortable_keys: ['value'],
            hideable: true
        }, {
            column_name: 'Status',
            icon: 'circle-info',
            visible: getColumnVisibilityFromStorage('Status'),
            sortable_keys: ['value'],
            hideable: true
        }, {
            column_name: 'isOnline',
            visible: getColumnVisibilityFromStorage('isOnline'),
            sortable_keys: ['value'],
            hideable: true
        },
        {
            column_name: 'Last Up',
            visible: getColumnVisibilityFromStorage('Last Update'),
            sortable_keys: ['value'],
            hideable: true
        },
        {
            column_name: 'Upl. By',
            visible: getColumnVisibilityFromStorage('Upl. By'),
            sortable_keys: ['value'],
            hideable: true
        },
        {
            column_name: 'Actions',
            visible: getColumnVisibilityFromStorage('Actions'),
            sortable_keys: [],
            hideable: false
        },
    ])

    async function buildColumns(listing: ListingRaw, skipLocalStorageCheck = false) {
        // Check for any pending updates in localStorage (unless skipped)
        if (!skipLocalStorageCheck) {
            const tempListingKey = `tempListing-${listing.listing_id}`
            const tempListing = localStorage.getItem(tempListingKey)
            
            if (tempListing) {
                const parsedTempListing = JSON.parse(tempListing)
                if (parsedTempListing.for === 'update') {
                    // Merge the temp listing data with the current listing
                    listing = {
                        ...listing,
                        is_online: parsedTempListing.is_online,
                        availability_date: parsedTempListing.availability_date,
                    }
                }
            }
        }

        const listing_data = {
            listing_id: listing.listing_id,
            title: listing.title,
            thumbnail: listing.thumbnail,
            // listing_details MV's image_name — the first listing_images
            // row's file_name. NULL when the listing has no images. Used
            // by the index page's "With / Without photo" filter without
            // having to wait for the per-row S3 thumbnail fetches.
            image_name: (listing as any).image_name ?? null,
            has_photo: !!(listing as any).image_name,
            is_online: listing.is_online,
            unit_number: listing.unit_number,
            street_address: listing.street_address,
            column_name: 'Listing',
            visible: getColumnVisibilityFromStorage('Listing'),
        }
        
        const price = {
            sale_price: listing.sale_price ? listing.sale_price : null,
            rent_price: listing.rent_price ? listing.rent_price : null,
            column_name: 'Price',
            visible: getColumnVisibilityFromStorage('Price'),
        }

        const price_per_sqm = {
            sale_price_per_sqm: listing.sale_price_per_sqm ? listing.sale_price_per_sqm : null,
            rent_price_per_sqm: listing.rent_price_per_sqm ? listing.rent_price_per_sqm : null,
            column_name: 'P/Sqm',
            visible: getColumnVisibilityFromStorage('P/Sqm'),
        }

        const condition = {
            value: listing.condition,
            column_name: 'Condition',
            visible: getColumnVisibilityFromStorage('Condition'),
        }
        
        // Display values come from the joined relation (listing.city /
        // listing.barangay / listing.contact). The legacy *_name columns
        // remain as a transition fallback inside the helpers until Phase E/F
        // physically drop them.
        const city = {
            value: getCityName(listing as any, ''),
            city_slug: getCitySlug(listing as any, ''),
            column_name: 'City',
            visible: getColumnVisibilityFromStorage('City'),
        }
        
        const availability = {
            value: listing.availability_date,
            column_name: 'Availability',
            visible: getColumnVisibilityFromStorage('Availability'),
        }
        
        const designation = {
            value:
                (listing as any).contact?.designation ??
                listing.contact_designation,
            column_name: 'Designation',
            visible: getColumnVisibilityFromStorage('Designation'),
        }

        // Contact card. id is the FK; name/email come from the joined
        // relation, with the legacy denorm columns as fallback. The remaining
        // contact_* fields (designation, home_phone, mobile_number) are also
        // about to move behind the join — surface from listing.contact when
        // present, fall back to the legacy column otherwise.
        const joinedContact = (listing as any).contact ?? null
        const contact = {
            id: listing.contact_id,
            name: getContactName(listing as any, ''),
            designation: joinedContact?.designation ?? listing.contact_designation,
            email: getContactEmail(listing as any, ''),
            home_phone: joinedContact?.home_phone ?? listing.contact_home_phone,
            mobile_number: joinedContact?.mobile_phone ?? listing.contact_mobile_number,
            column_name: 'Contact',
            visible: getColumnVisibilityFromStorage('Contact'),
        }
        
        const bedrooms = {
            value: listing.bedrooms,
            column_name: 'Bedrooms',
            visible: getColumnVisibilityFromStorage('Bedrooms'),
        }
        
        const bathrooms = {
            value: listing.bathrooms,
            column_name: 'Bathrooms',
            visible: getColumnVisibilityFromStorage('Bathrooms'),
        }
        
        const floor_area = {
            value: listing.floor_area,
            column_name: 'Floor Area',
            visible: getColumnVisibilityFromStorage('Floor Area'),
        }
        
        const lot_area = {
            value: listing.lot_area,
            column_name: 'Lot Area',
            visible: getColumnVisibilityFromStorage('Lot Area'),
        }

        const barangay = {
            value: getBarangayName(listing as any, ''),
            column_name: 'Barangay',
            visible: getColumnVisibilityFromStorage('Barangay'),
        }
        
        const parking_spaces = {
            value: listing.parking_spaces,
            column_name: 'Parking Spaces',
            visible: getColumnVisibilityFromStorage('Parking Spaces'),
        }
        
        //map status to label
        const statusMapping = {
            'available': 'AVAILABLE',
            'occupied-rented': 'TENANTED',
            'on-hold': 'ON HOLD',
            'under-negotiation': 'UNDER NEGOTIATION',
            'sold': 'SOLD'
        }

        const property_type = {
            value: listing.property_type,
            column_name: 'Property Type',
            visible: getColumnVisibilityFromStorage('Property Type'),
        }

        const property_name = {
            value: listing.property_name,
            column_name: 'Building Name',
            visible: getColumnVisibilityFromStorage('Building Name'),
        }

        const status = {
            label: statusMapping[listing.status as keyof typeof statusMapping],
            value: listing.status,
            column_name: 'Status',
            visible: getColumnVisibilityFromStorage('Status'),
        }

        const remarks = {
            value: listing.remarks,
            column_name: 'Remarks',
            visible: getColumnVisibilityFromStorage('Remarks'),
        }

        const actions = {   
            column_name: 'Actions',
            visible: getColumnVisibilityFromStorage('Actions'),
        }

        const is_online = {   
            value: listing.is_online,
            column_name: 'isOnline',
            visible: getColumnVisibilityFromStorage('isOnline'),
        }

        const category = {
            value: String(listing.property_category ?? listing.category ?? 'residential'),
            column_name: 'Category',
            visible: getColumnVisibilityFromStorage('Category'),
        }

        const created_at = {
            value: listing.created_at,
            column_name: 'Created At',
            visible: getColumnVisibilityFromStorage('Created At'),
        }

        const updated_at = {
            value: new Date(listing.updated_at).toLocaleString(),
            column_name: 'Last Update',
            visible: getColumnVisibilityFromStorage('Last Update'),
        }

        // listing.created_by has historically been either a UUID string,
        // a numeric legacy id, or an embedded profile object — the
        // strict type narrows to `never` so cast for the property probe.
        const cb: any = (listing as any).created_by
        const cbName: string = String(
            (typeof cb === 'object' && cb?.full_name)
                ? cb.full_name
                : ((listing as any).created_by_name || cb || 'Data not available')
        )
        const uploaded_by = {
            value: cbName,
            column_name: 'Upl. By',
            visible: getColumnVisibilityFromStorage('Upl. By'),
        }

        // After building the columns, check if we need to update any existing column
        const existingIndex = listingColumnsData.findIndex(
            col => col.listing_data.listing_id === listing.listing_id
        )
        
        // Cast satisfies the listingColumns row schema — several
        // upstream `value` fields are nullable in the source data and
        // the schema's strict `value: string` would otherwise reject
        // them. Runtime always stringifies before render.
        const row = {
            listing_data, remarks,
            price, price_per_sqm, condition, city, availability, designation, contact,
            bedrooms, bathrooms, floor_area, lot_area, parking_spaces, status, actions, barangay,
            category, created_at, is_online, updated_at, uploaded_by, just_created: false, property_type, property_name
        } as any
        if (existingIndex !== -1) {
            listingColumnsData[existingIndex] = row
        } else {
            listingColumnsData.push(row)
        }

        fetchListingsEnded.value = true
    }

    function setColumnVisibility(column_name: string) {
        listingColumnsData.forEach(row => {
            Object.values(row).forEach(col => {
                if (typeof col === 'object' && col !== null && 'column_name' in col && col.column_name === column_name) {
                    col.visible = !col.visible
                }
            })
        })
    }

    function destroyListings() {
        listingColumnsData.length = 0
    }

    async function archiveListing(listing_id: number) {
        try {
            return await $fetch(`/api/listings/${listing_id}/archive`, { method: 'POST' })
        } catch (error) {
            console.error('Error archiving listing:', error)
            throw error
        }
    }

    async function clearListingsColumns() {
        listingColumnsData.length = 0

        console.log("listingColumnsData cleared")
    }
    
    async function unarchiveListing(listing_id: number) {
        try {
            return await $fetch(`/api/listings/${listing_id}/unarchive`, { method: 'POST' })
        } catch (error) {
            console.error('Error unarchiving listing:', error)
            throw error
        }
    }

    async function deleteListing(id: number) {
        let data
        try {
            data = await $fetch(`/api/listings/${id}/soft-delete`, { method: 'POST' })
        } catch (error) {
            console.error('Error deleting listing:', error)
            throw new Error('Failed to delete listing')
        }

        localStorage.setItem(
            `tempListing-${id}`,
            JSON.stringify({
                listing_id: id,
                for: 'deletion',
            })
        )

        await deleteImages(id)

        return { data }
    }

    async function updateListingRemarks(listing_id: number, remarks: string) {
        let data
        try {
            data = await $fetch(`/api/listings/${listing_id}/remarks`, {
                method: 'PATCH',
                body: { remarks },
            })
        } catch (error) {
            console.error('Error updating listing remarks:', error)
            throw new Error('Failed to update listing remarks')
        }

        if (data) {
            const listingToUpdate = listingColumnsData.find(listing => listing.listing_data.listing_id === listing_id)
            if (listingToUpdate) {
                listingToUpdate.remarks.value = remarks
            }
        }

        return { data }
    }

    async function cloneListing(listing_id: number) {
        try {
            const cloned: any = await $fetch(`/api/listings/${listing_id}/clone`, {
                method: 'POST',
            })

            // Image cloning is best-effort; the listing already exists.
            try {
                const ImagesController = (await import('@/services/images/imagesController')).default
                const imagesController = await ImagesController.create(cloned.id)
                await imagesController.cloneImages(listing_id, cloned.id)
            } catch (imageError) {
                console.error('Error cloning images:', imageError)
            }

            return cloned
        } catch (error) {
            console.error('Error in cloneListing function:', error)
            throw error
        }
    }
    
    return {
        listingColumnsData, buildColumns, setColumnVisibility,
        listingColumnsArray, destroyListings, archiveListing, unarchiveListing, deleteListing, cloneListing, clearListingsColumns,
        updateListingRemarks
    }
})


