import { callGenerateDocx, downloadFromUrl, escapeHtml } from './_helpers'

// Authority-to-Sell generator. Server emits the canonical DOCX, persists
// it, and audit-logs a document.uploaded event. We pass property + owner
// metadata so the document shows up in the linked listing's timeline
// (and on the related contact's timeline when the form learns to pass
// contact_id).

export const generateAuthorityToSell = async (formData) => {
  try {
    const origin = window.location.origin
    const property = formData.property || {}
    const owner = formData.ownerData || {}

    const response = await fetch(
      `${origin}/document-templates/Residential Authority to Sell to Owner Name.html`
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

    // Every interpolated value is HTML-escaped — names like "Smith & Co"
    // or addresses with `<` characters used to corrupt the resulting
    // DOCX silently.
    htmlTemplate = htmlTemplate
      .replace(/{{property_name}}/g,            escapeHtml(property.name))
      .replace(/{{property_address}}/g,         escapeHtml(property.address))
      .replace(/{{property_title_number}}/g,    escapeHtml(property.property_title_number))
      .replace(/{{property_total_floor_area}}/g, escapeHtml(property.total_floor_area))
      .replace(/{{property_selling_price}}/g,   escapeHtml(property.selling_price))
      .replace(/{{owner_name}}/g,               escapeHtml(owner.ownerName))
      .replace(/{{owner_home_address}}/g,       escapeHtml(owner.ownerHomeAddress))
      .replace(/{{owner_email_address}}/g,      escapeHtml(owner.ownerEmailAddress))
      .replace(/{{owner_telephone_number}}/g,   escapeHtml(owner.ownerTelephoneNumber))
      .replace(/{{signature_date}}/g,           escapeHtml(formData.signatureDate))

    const documentName = `Authority to Sell-${owner.ownerName || 'Unknown'}`
    const result = await callGenerateDocx(htmlTemplate, documentName, {
      listing_id: property.id ?? property.listing_id ?? null,
      owner_name: owner.ownerName ?? null,
      contact_id: owner.contact_id ?? null,
    })

    if (result.fileUrl) downloadFromUrl(result.fileUrl, `${documentName}.docx`)
    return result.fileUrl
  } catch (error) {
    console.error('Authority-to-Sell generation failed:', error)
    throw error
  }
}
