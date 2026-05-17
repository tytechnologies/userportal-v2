import { asBlob } from 'html-docx-js-typescript'

/**
 * Upload PDF to S3 and save document record in DB (via server API).
 * Server stamps owner_user_id from auth.uid() and emits a
 * `document.uploaded` audit row carrying contact_id / listing_id when
 * provided — that's what wires the doc into the unified CRM timeline.
 *
 * Optional `links` lets the caller thread cross-entity references:
 *   - contactId  → makes the doc surface on the contact's timeline
 *   - listingId  → makes the doc surface on the listing's timeline
 */
const saveDocumentToS3 = async (pdfBytes, clientName, links = {}) => {
  // Chunked base64 encoding — `String.fromCharCode(...big array)` and a
  // per-byte .reduce(... + String.fromCharCode(byte)) both throw or hang
  // on large PDFs (multi-MB viewing lists). 0x8000 chunks stay within
  // the JS engine's argument limit and avoid the per-byte concat cost.
  const bytes = new Uint8Array(pdfBytes)
  const chunkSize = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + chunkSize),
    )
  }
  const base64 = btoa(binary)

  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const res = await fetch(`${origin}/api/documents/upload-viewing-list-pdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pdfBase64: base64,
      clientName,
      contactId: links.contactId ?? null,
      listingId: links.listingId ?? null,
    }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    const message =
      err?.data?.message ||
      err?.statusMessage ||
      err?.message ||
      res.statusText ||
      'Failed to upload PDF to S3'
    throw new Error(message)
  }
  const { url } = await res.json()
  return url
}

function formatDate(date) {
  if (!date) return ''
  const [year, month, day] = String(date).split('-')
  if (!month || !day) return date
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ]
  return `${day} ${months[parseInt(month) - 1]} ${year}`
}

function formatTime(time) {
  if (!time) return ''
  const [hours, minutes] = String(time).split(':')
  if (hours === undefined) return time
  const period = Number(hours) >= 12 ? 'PM' : 'AM'
  const displayHours = Number(hours) % 12 || 12
  return `${displayHours}:${minutes || '00'} ${period}`
}

export const generateResidentialViewingList = async (formData) => {
  try {
    if (!formData) throw new Error('Form data is required')
    const properties = Array.isArray(formData.properties)
      ? formData.properties
      : []
    const origin = window.location.origin
    // 1. Fetch the HTML template
    const response = await fetch(
      `${origin}/document-templates/Residential Viewing List for Client.html`
    )
    if (!response.ok) throw new Error('Failed to load document template')
    let htmlTemplate = await response.text()

    let listingsTableData = ''
    properties.forEach((listing, index) => {
      const parking_spots =
        listing.parking_spaces === null || listing.parking_spaces === 0
          ? 'No parking'
          : `${listing.parking_spaces} parking slot${
              listing.parking_spaces > 1 ? 's' : ''
            }`
      const rent_sale_info = `${
        listing.rent_price ? `Rent: ₱${listing.rent_price}/month` : ''
      }${listing.rent_price && listing.sale_price ? ', ' : ''}${
        listing.sale_price ? `Sale: ₱${listing.sale_price}` : ''
      }`.trim() || '-'
      const label = listing.label ?? ''
      const address = listing.address ?? ''
      const cityName = listing.city?.name ?? listing.city_name ?? ''
      const condition = listing.condition ?? ''
      const floorArea = listing.floor_area ?? ''
      const bedrooms = listing.bedrooms ?? ''
      const bathrooms = listing.bathrooms ?? ''
      const listingId = listing.listing_id ?? ''
      listingsTableData += `
      <tr valign="top">
        <td width="6" height="23" style="border: 1px solid #000000; padding: 0in 0.06in">
          <p>${index + 1}</p>
        </td>
        <td width="250" style="break-word: break-all; border: 1px solid #000000; padding: 0in 0.06in">
          <p>${label}, ${address} , ${cityName}</p>
        </td>
        <td width="203" style="break-word: break-all; border: 1px solid #000000; padding: 0in 0.06in">
          <p>
            ${condition}, Floor area: ${floorArea}, ${bedrooms} Bedrooms, ${bathrooms} Bathrooms, ${parking_spots}
          </p>
        </td>
        <td width="103" style="break-word: break-all; border: 1px solid #000000; padding: 0in 0.06in">
          <p>
            ${rent_sale_info}
          </p>
        </td>
        <td width="75" style="break-word: break-all; border: 1px solid #000000; padding: 0in 0.06in">
          <p style="word-break: break-all;">
            <br />
            <br />
            <a style="word-break: break-all;" href="https://housinginteractive.com.ph/property/${cityName}-${listingId}">
              <font color="#0000ff">View Property</font>
            </a>
          </p>
        </td>
      </tr>
      `
    })

    // 2. Replace placeholders with form data
    htmlTemplate = htmlTemplate
      .replace(/{{client-name}}/g, formData.client_name ?? '')
      .replace(/{{viewing-date}}/g, formatDate(formData.viewing_date))
      .replace(/{{viewing-time}}/g, formatTime(formData.viewing_time))
      .replace(/{{listings-table-data}}/g, listingsTableData)
      .replace(/{{broker-name}}/g, formData.broker_name ?? '')

    // 3. Create a temporary container
    const tempDiv = document.createElement('div')
    tempDiv.innerHTML = htmlTemplate
    document.body.appendChild(tempDiv)

    // 5. Generate PDF with proper image handling
    const html2pdf = (await import('html2pdf.js')).default
    const opt = {
      margin: 10,
      filename: `Viewing List for Client - ${formData.client_name}.pdf`,
      image: {
        type: 'jpeg',
        quality: 0.98,
      },
      html2canvas: {
        scale: 2,
        useCORS: true, // Enable cross-origin images
        allowTaint: true, // Allow tainted images
        logging: true, // Helpful for debugging
        async: true, // Ensure proper async rendering
      },
      jsPDF: {
        unit: 'mm',
        format: 'a4',
        orientation: 'portrait',
      },
    }

    const pdfBytes = await html2pdf()
      .set(opt)
      .from(tempDiv)
      .outputPdf('arraybuffer')

    console.log('pdf: ', pdfBytes)

    // 6. Clean up
    document.body.removeChild(tempDiv)

    // 7. Save the PDF to S3 and document record in DB. Cross-entity
    // links: contactId pivots the resulting audit row into the contact's
    // timeline; listingId pivots into the listing's. The form passes
    // these in formData when available; null if not (the doc still
    // saves, it just doesn't surface in those feeds).
    const user = useSupabaseUser()
    if (!user.value) throw new Error('User not authenticated')
    await saveDocumentToS3(pdfBytes, `${formData.client_name}`, {
      contactId: formData.contact_id ?? null,
      // The form lets the user pick multiple properties; if exactly one
      // was chosen we link it. If multiple, we don't pick arbitrarily —
      // the timeline simply won't pivot on listing_id in that case.
      listingId:
        Array.isArray(properties) && properties.length === 1
          ? properties[0]?.listing_id ?? null
          : null,
    })

    const docxBlob = await asBlob(htmlTemplate, {
      orientation: 'portrait',
      margins: { top: 720, right: 720, bottom: 720, left: 720 },
    })

    const url = window.URL.createObjectURL(docxBlob)
    const a = document.createElement('a')
    a.href = url
    a.download = `Viewing List for Client - ${formData.client_name}.docx`
    document.body.appendChild(a)
    a.click()
    window.URL.revokeObjectURL(url)
    a.remove()

    return docxBlob
  } catch (error) {
    console.error('Document generation failed:', error)
    throw error
  }
}
