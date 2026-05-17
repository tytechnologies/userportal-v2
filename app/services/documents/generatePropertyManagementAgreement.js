import { callGenerateDocx, downloadFromUrl, escapeHtml } from './_helpers'

// Property-Management-Agreement generator. Server emits the canonical
// DOCX; metadata threads cross-entity links into the unified timeline.

export const generatePropertyManagementAgreement = async (formData) => {
  try {
    const origin = window.location.origin
    const owner = formData.ownerData || {}
    const property = formData.propertyData || {}
    const contract = formData.contractData || {}

    const response = await fetch(
      `${origin}/document-templates/Residential Property Management to Owner Name.html`
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
      .replace(/{{owner_name}}/g,            escapeHtml(owner.ownerName))
      .replace(/{{owner_nationality}}/g,     escapeHtml(owner.ownerNationality))
      .replace(
        /{{owner_home_address}}/g,
        escapeHtml(owner.ownerHomeAddress ?? owner.ownerAddress),
      )
      .replace(/{{property_address}}/g,      escapeHtml(property.propertyAddress))
      .replace(/{{property_parking_spaces}}/g, escapeHtml(property.propertyParkingSpaces))
      .replace(/{{signature_date}}/g,        escapeHtml(contract.signatureDate))
      .replace(/{{property_city}}/g,         escapeHtml(property.propertyCity))
      .replace(/{{property_manager_name}}/g, escapeHtml(property.propertyManagerName))

    const documentName = `Property Management Agreement for ${
      owner.ownerName || 'Unknown'
    }`
    const result = await callGenerateDocx(htmlTemplate, documentName, {
      listing_id: property.id ?? property.listing_id ?? null,
      owner_name: owner.ownerName ?? null,
      contact_id: owner.contact_id ?? null,
    })

    if (result.fileUrl) downloadFromUrl(result.fileUrl, `${documentName}.docx`)
    return result.fileUrl
  } catch (error) {
    console.error('Property-Management-Agreement generation failed:', error)
    throw error
  }
}
