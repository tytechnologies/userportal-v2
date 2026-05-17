export async function generateReport(listingColumnsData) {
  try {
    console.log('listingColumnsData from generate-report: ', listingColumnsData)

    // Transform listingColumnsData to CSV
    const fields = [
      'ID',
      'Title',
      'Price Type',
      'Price',
      'Price per sqm',
      'Condition',
      'City',
      'Availability',
      'Category',
      'Designation',
      'Contact',
      'Bedrooms',
      'Bathrooms',
      'Floor Area',
      'Lot Area',
      'Parking Spaces',
      'Type',
    ]

    // Create CSV headers
    let csv = fields.join(',') + '\n'

    // We need to split listing entries that has both sale and rent prices into individual factorized rows for each
    const factorizedListingColumnsData = listingColumnsData
      .map((columnData) => {
        const baseData = {
          listing_data: columnData.listing_data,
          price_type: '',
          price: {},
          price_per_sqm: {},
          condition: columnData.condition,
          city: columnData.city,
          availability: columnData.availability,
          designation: columnData.designation,
          contact: columnData.contact,
          bedrooms: columnData.bedrooms,
          bathrooms: columnData.bathrooms,
          floor_area: columnData.floor_area,
          lot_area: columnData.lot_area,
          parking_spaces: columnData.parking_spaces,
          status: columnData.status,
          category: columnData.category,
        }

        if (columnData.price.sale_price && columnData.price.rent_price) {
          // Create two entries - one for sale and one for rent
          const saleData = {
            ...baseData,
            price_type: 'Sale',
            price: { sale_price: columnData.price.sale_price },
            price_per_sqm: {
              sale_price_per_sqm: columnData.price_per_sqm.sale_price_per_sqm,
            },
          }
          const rentData = {
            ...baseData,
            price_type: 'Rent',
            price: { rent_price: columnData.price.rent_price },
            price_per_sqm: {
              rent_price_per_sqm: columnData.price_per_sqm.rent_price_per_sqm,
            },
          }
          return [saleData, rentData]
        }
        if (columnData.price.sale_price) {
          const saleData = {
            ...baseData,
            price_type: 'Sale',
            price: { sale_price: columnData.price.sale_price },
            price_per_sqm: {
              sale_price_per_sqm: columnData.price_per_sqm.sale_price_per_sqm,
            },
          }
          return [saleData]
        }
        if (columnData.price.rent_price) {
          const rentData = {
            ...baseData,
            price_type: 'Rent',
            price: { rent_price: columnData.price.rent_price },
            price_per_sqm: {
              rent_price_per_sqm: columnData.price_per_sqm.rent_price_per_sqm,
            },
          }
          return [rentData]
        }

        return [columnData]
      })
      .flat()

    console.log('factorizedListingColumnsData: ', factorizedListingColumnsData)

    for (const columnData of factorizedListingColumnsData) {
      // Get the listing_data from the columnData
      const listing_id = columnData.listing_data.listing_id
      const title = columnData.listing_data.title
      const price = columnData.price.sale_price ?? columnData.price.rent_price

      const price_type = columnData.price_type
      const price_per_sqm =
        columnData.price_per_sqm.sale_price_per_sqm ??
        columnData.price_per_sqm.rent_price_per_sqm

      const condition = columnData.condition.value
      const city = columnData.city.value
      const availability = columnData.availability.value
      const designation = columnData.designation.value
      const category = columnData.category.value
      const contact_mobile_number = columnData.contact.mobile_number
      const bedrooms = columnData.bedrooms.value
      const bathrooms = columnData.bathrooms.value
      const floor_area = columnData.floor_area.value
      const lot_area = columnData.lot_area.value
      const parking_spaces = columnData.parking_spaces.value
      const status = columnData.status.value

      // Create a CSV row
      const row = [
        listing_id,
        title,
        price_type,
        price,
        price_per_sqm,
        condition,
        city,
        availability,
        category,
        designation,
        contact_mobile_number,
        bedrooms,
        bathrooms,
        floor_area,
        lot_area,
        parking_spaces,
        status,
      ]

      // Add the row to the CSV
      csv += row.join(',') + '\n'
    }

    return csv
  } catch (error) {
    console.error('Error generating report:', error)
    throw new Error('Error generating report')
  }
}
