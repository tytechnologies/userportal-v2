// Checklist generare displayedListingColumns
import { useListingColumnsAtom, useListingsRawAtom } from '@/store'
import ListingService from '~/services/listing.services'

const { buildColumns, clearListingsColumns } = useListingColumnsAtom()
const { clearListings } = useListingsRawAtom()

// - [ x ] 1. fetch listing_details
async function fetchListingDetails(listingsShowingType) {
  clearListingsColumns()
  clearListings()

  const listingsData =
    listingsShowingType === 'personal'
      ? await ListingService._getListings()
      : await ListingService._getOtherBrokerListings()

  return listingsData
}

// - [ x ] 2. check for existing local storage keys for (newly added, deleted, updated)
function checkForExistingLocalStorageKeys() {
  const existingKeys = Object.keys(localStorage).filter((key) =>
    key.startsWith('tempListing-')
  )

  return existingKeys
}

// - [ x ] 3. complete correct operations for each key
async function completeCorrectOperationsForEachKey(listingsData) {
  let currentListings = listingsData
  const existingKeys = checkForExistingLocalStorageKeys()

  existingKeys.forEach(async (key) => {
    const keyListing = JSON.parse(localStorage.getItem(key))
    if (keyListing.for === 'creation') {
      //push key keyListing to listingsData array
      currentListings.push(keyListing)

      // remove localStorage.tempListing-key
      localStorage.removeItem(key)
    } else if (keyListing.for === 'deletion') {
      currentListings = currentListings.filter(
        (listing) => listing.id !== keyListing.id
      )

      // remove localStorage.tempListing-key
      localStorage.removeItem(key)
    } else if (keyListing.for === 'update') {
      currentListings = currentListings.map((listing) =>
        listing.id === keyListing.id ? keyListing : listing
      )

      // remove localStorage.tempListing-key
      localStorage.removeItem(key)
    }
  })

  return currentListings
}

// - [ x ] 4. update local storage
// function updateLocalStorage(listingsData) {
//   const existingKeys = checkForExistingLocalStorageKeys()
//   //delete all existing keys
//   existingKeys.forEach((key) => {
//     localStorage.removeItem(key)
//   })
//   //add new keys
//   listingsData.forEach((listing) => {
//     localStorage.setItem(listing.id, JSON.stringify(listing))
//   })
// }

// - [ ] 5. build displayedListingColumns
export async function buildDisplayedListingColumns(listingsShowingType) {
  const listingsData = await fetchListingDetails(listingsShowingType)
  const currentListings = await completeCorrectOperationsForEachKey(
    listingsData
  )

  currentListings.forEach((listing) => {
    buildColumns(listing)
  })
}
