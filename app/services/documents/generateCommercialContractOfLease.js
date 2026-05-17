import { callGenerateDocx, downloadFromUrl, escapeHtml } from './_helpers'

// Commercial Contract of Lease generator. Server emits the canonical
// DOCX; metadata threads cross-entity links so the doc surfaces in the
// linked listing's / contact's unified timeline.

export const generateCommercialContractOfLease = async (formData) => {
  try {
    const origin = window.location.origin
    const lessor = formData.lessorData || {}
    const lessee = formData.lesseeData || {}
    const property = formData.propertyData || {}
    const contract = formData.contractData || {}
    const owner = formData.ownerData || {}

    const response = await fetch(
      `${origin}/document-templates/Commercial Contract of Lease to Representative Name.html`
    )
    if (!response.ok) {
      throw new Error(
        `Failed to fetch template: ${response.status} ${response.statusText}`,
      )
    }
    let htmlTemplate = await response.text()
    if (!htmlTemplate || htmlTemplate.length < 100) {
      throw new Error('Template file is empty or unexpectedly small.')
    }

    htmlTemplate = htmlTemplate
      .replace(/{{lessor_name}}/g,             escapeHtml(lessor.lessor_name))
      .replace(/{{lessor_nationality}}/g,      escapeHtml(lessor.lessor_nationality))
      .replace(/{{lessor_address}}/g,          escapeHtml(lessor.lessor_address))
      .replace(/{{lessee_name}}/g,             escapeHtml(lessee.lessee_name))
      .replace(/{{lessee_nationality}}/g,      escapeHtml(lessee.lessee_nationality))
      .replace(/{{lessee_address}}/g,          escapeHtml(lessee.lessee_address))
      .replace(/{{lessee_designation}}/g,      escapeHtml(lessee.lessee_designation))
      .replace(/{{lessee_property_address}}/g, escapeHtml(lessee.lessee_property_address))
      .replace(/{{property_type}}/g,           escapeHtml(property.property_type))
      .replace(/{{property_name}}/g,           escapeHtml(property.property_name))
      .replace(/{{property_area}}/g,           escapeHtml(property.property_area))
      .replace(/{{lease_period}}/g,            escapeHtml(contract.lease_period))
      .replace(/{{lease_start_date}}/g,        escapeHtml(contract.lease_start_date))
      .replace(/{{free_rent_period}}/g,        escapeHtml(contract.freeRentPeriod))
      .replace(/{{free_rent_start_date}}/g,    escapeHtml(contract.freeRentStartDate))
      .replace(/{{lease_end_date}}/g,          escapeHtml(contract.leaseEndDate))
      .replace(/{{monthly_rent}}/g,            escapeHtml(contract.monthlyRent))
      .replace(/{{advance_rent_period}}/g,     escapeHtml(contract.advanceRentPeriod))
      .replace(/{{owner_name}}/g,              escapeHtml(owner.ownerName))
      .replace(/{{owner_nationality}}/g,       escapeHtml(owner.ownerNationality))
      .replace(/{{owner_home_address}}/g,      escapeHtml(owner.ownerHomeAddress))
      .replace(/{{property_address}}/g,        escapeHtml(property.propertyAddress))
      .replace(/{{property_parking_spaces}}/g, escapeHtml(property.propertyParkingSpaces))
      .replace(/{{signature_date}}/g,          escapeHtml(contract.signatureDate))
      .replace(/{{property_city}}/g,           escapeHtml(property.propertyCity))
      .replace(/{{property_manager_name}}/g,   escapeHtml(property.propertyManagerName))

    const documentName = `Commercial Contract of Lease to ${
      lessee.lessee_name || 'Unknown'
    }`
    const result = await callGenerateDocx(htmlTemplate, documentName, {
      listing_id: property.id ?? property.listing_id ?? null,
      lessor_name: lessor.lessor_name ?? null,
      lessee_name: lessee.lessee_name ?? null,
      owner_name: owner.ownerName ?? null,
      contact_id:
        lessor.contact_id ?? lessee.contact_id ?? owner.contact_id ?? null,
    })

    if (result.fileUrl) downloadFromUrl(result.fileUrl, `${documentName}.docx`)
    return result.fileUrl
  } catch (error) {
    console.error('Commercial Contract of Lease generation failed:', error)
    throw error
  }
}
