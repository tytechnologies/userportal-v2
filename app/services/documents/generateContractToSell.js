import { callGenerateDocx, downloadFromUrl, escapeHtml } from './_helpers'

// Contract-to-Sell generator. Server emits the canonical DOCX; we pass
// metadata so the doc surfaces in the linked listing's / contact's
// unified timeline.

export const generateContractToSell = async (formData) => {
  try {
    const origin = window.location.origin
    const seller = formData.sellerData || {}
    const buyer = formData.buyerData || {}
    const property = formData.propertyDetails || {}
    const contract = formData.contractData || {}
    const now = new Date()
    const contractDay = contract.contractDay ?? String(now.getDate())
    const contractMonth = contract.contractMonth ?? String(now.getMonth() + 1)
    const contractYear = contract.contractYear ?? String(now.getFullYear())

    const response = await fetch(
      `${origin}/document-templates/Residential Contract to Sell to FULL NAME.html`
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

    // Every interpolated value is HTML-escaped.
    htmlTemplate = htmlTemplate
      .replace(/{{contractDay}}/g,           escapeHtml(contractDay))
      .replace(/{{contractMonth}}/g,         escapeHtml(contractMonth))
      .replace(/{{contractYear}}/g,          escapeHtml(contractYear))
      .replace(/{{lessorName}}/g,            escapeHtml(seller.sellerName))
      .replace(/{{lessorSpouse}}/g,          escapeHtml(seller.sellerSpouse))
      .replace(/{{lessorNationality}}/g,     escapeHtml(seller.sellerNationality))
      .replace(/{{lessorAddress}}/g,         escapeHtml(seller.sellerAddress))
      .replace(/{{lesseeName}}/g,            escapeHtml(buyer.buyerName))
      .replace(/{{lesseeNationality}}/g,     escapeHtml(buyer.buyerNationality))
      .replace(/{{lesseeAddress}}/g,         escapeHtml(buyer.buyerAddress))
      .replace(/{{propertyName}}/g,          escapeHtml(property.property_name))
      .replace(/{{propertyArea}}/g,          escapeHtml(property.property_area))
      .replace(/{{propertyTitleNumber}}/g,   escapeHtml(property.property_title_number))
      .replace(
        /{{contractPrice}}/g,
        escapeHtml(contract.contractPrice ?? property.property_price),
      )
      .replace(/{{uponSigningPrice}}/g,      escapeHtml(contract.uponSigningPrice))
      .replace(/{{balanceLeftPrice}}/g,      escapeHtml(contract.balanceLeftPrice))
      .replace(/{{contractTerm}}/g,          escapeHtml(contract.contractTerm))
      .replace(/{{postDatedChecks}}/g,       escapeHtml(contract.postDatedChecks))

    const documentName = `Contract to Sell to ${seller.sellerName || 'Unknown'}`
    const result = await callGenerateDocx(htmlTemplate, documentName, {
      listing_id: property.id ?? property.listing_id ?? null,
      seller_name: seller.sellerName ?? null,
      buyer_name: buyer.buyerName ?? null,
      contact_id: seller.contact_id ?? buyer.contact_id ?? null,
    })

    if (result.fileUrl) downloadFromUrl(result.fileUrl, `${documentName}.docx`)
    return result.fileUrl
  } catch (error) {
    console.error('Contract-to-Sell generation failed:', error)
    throw error
  }
}
