import { callGenerateDocx, downloadFromUrl, escapeHtml } from './_helpers'

// Deed-of-Absolute-Sale generator. Server emits the canonical DOCX; we
// pass metadata so the doc surfaces in the linked listing's / contact's
// unified timeline.

export const generateDeedOfAbsoluteSell = async (formData) => {
  try {
    const origin = window.location.origin

    // Map form fields: seller=lessor, buyer=lessee.
    const seller = formData.sellerData || {}
    const buyer = formData.buyerData || {}
    const property = formData.propertyDetails || {}
    const contract = formData.contractData || {}
    const now = new Date()
    const contractDay = contract.contractDay ?? String(now.getDate())
    const contractMonth = contract.contractMonth ?? String(now.getMonth() + 1)
    const contractYear = contract.contractYear ?? String(now.getFullYear())
    const contractCity = contract.contractCity ?? 'Manila'
    const contractPrice = contract.contractPrice ?? property.property_price ?? ''

    const response = await fetch(
      `${origin}/document-templates/residential-deed-of-sale-to-full-name.html`
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
      .replace(/{{contractDay}}/g,                              escapeHtml(contractDay))
      .replace(/{{contractMonth}}/g,                            escapeHtml(contractMonth))
      .replace(/{{contractYear}}/g,                             escapeHtml(contractYear))
      .replace(/{{contractCity}}/g,                             escapeHtml(contractCity))
      .replace(/{{lessorName}}/g,                               escapeHtml(seller.sellerName))
      .replace(/{{lessorSpouse}}/g,                             escapeHtml(seller.sellerSpouse))
      .replace(/{{lessorNationality}}/g,                        escapeHtml(seller.sellerNationality))
      .replace(/{{lessorAddress}}/g,                            escapeHtml(seller.sellerAddress))
      .replace(/{{lesseeName}}/g,                               escapeHtml(buyer.buyerName))
      .replace(/{{lesseeNationality}}/g,                        escapeHtml(buyer.buyerNationality))
      .replace(/{{lesseeAddress}}/g,                            escapeHtml(buyer.buyerAddress))
      .replace(/{{propertyDetails.property_name}}/g,            escapeHtml(property.property_name))
      .replace(/{{propertyDetails.property_address}}/g,         escapeHtml(property.property_address))
      .replace(/{{propertyDetails.property_area}}/g,            escapeHtml(property.property_area))
      .replace(/{{propertyDetails.property_title_number}}/g,    escapeHtml(property.property_title_number))
      .replace(/{{contractPrice}}/g,                            escapeHtml(contractPrice))

    const documentName = `Deed of Absolute Sale to ${buyer.buyerName || 'Unknown'}`
    const result = await callGenerateDocx(htmlTemplate, documentName, {
      listing_id: property.id ?? property.listing_id ?? null,
      seller_name: seller.sellerName ?? null,
      buyer_name: buyer.buyerName ?? null,
      contact_id: seller.contact_id ?? buyer.contact_id ?? null,
    })

    if (result.fileUrl) downloadFromUrl(result.fileUrl, `${documentName}.docx`)
    return result.fileUrl
  } catch (error) {
    console.error('Deed-of-Absolute-Sale generation failed:', error)
    throw error
  }
}
