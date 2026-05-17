import { formatDate, monthsToWords } from '~/helpers/helpers'
import * as LOIhelpers from './LOIhelpers'
import { callGenerateDocx, downloadFromUrl } from './_helpers'

export const generateLOI = async (formData) => {
  try {
    console.log('formData: ', formData)

    const origin = window.location.origin
    // 1. Fetch the HTML template (with explicit ok-check so a missing
    // file doesn't silently produce a DOCX containing a 404 page).
    const response = await fetch(
      `${origin}/document-templates/residential-loi-for-rent-to-first-name-last-name.html`
    )
    if (!response.ok) {
      throw new Error(
        `Failed to fetch LOI template: ${response.status} ${response.statusText}`,
      )
    }
    let htmlTemplate = await response.text()
    if (!htmlTemplate || htmlTemplate.length < 100) {
      throw new Error('LOI template file is empty or unexpectedly small.')
    }

    const requestString = `
      ${formData.letterData.requests.map(
        (request) => `
          <ul class="awlist5" style="margin:0pt; padding-left:0pt">
            <li style="margin-left:72pt; text-indent:-18pt; text-align:justify">
              <span
                style="width:9.75pt; font:7pt 'Times New Roman'; display:inline-block">&#xa0;&#xa0;&#xa0;&#xa0;&#xa0;&#xa0;
              </span>${request.value}
            </li>
          </ul>
          <p>
            &#xa0;
          </p>
        `
      )}
    `

    const minLeaseTermMonths =
      formData.contractData.minLeaseTermUnit == 'years'
        ? formData.contractData.minLeaseTermValue * 12
        : formData.contractData.minLeaseTermUnit == 'months'
        ? formData.contractData.minLeaseTermValue
        : formData.contractData.minLeaseTermUnit == 'days'
        ? formData.contractData.minLeaseTermValue / 30
        : formData.contractData.minLeaseTermValue

    const advanceRentalMonths =
      formData.contractData.advanceRentalUnit == 'years'
        ? formData.contractData.advanceRentalValue * 12
        : formData.contractData.advanceRentalUnit == 'months'
        ? formData.contractData.advanceRentalValue
        : formData.contractData.advanceRentalUnit == 'days'
        ? formData.contractData.advanceRentalValue / 30
        : formData.contractData.advanceRentalValue

    const securityDepositMonths =
      formData.contractData.securityDepositUnit == 'years'
        ? formData.contractData.securityDepositValue * 12
        : formData.contractData.securityDepositUnit == 'months'
        ? formData.contractData.securityDepositValue
        : formData.contractData.securityDepositUnit == 'days'
        ? formData.contractData.securityDepositValue / 30
        : formData.contractData.securityDepositValue

    const recipientString = LOIhelpers.generateRecipientString(
      formData.lessorData.contactPersonGender,
      formData.lessorData.contactPersonName,
      formData.contractData.propertyAddress,
      formData.lessorData.contactPersonDesignation
    )

    const propertyInfoString = LOIhelpers.generatePropertyInfoString(
      formData.contractData.propertyTitle.label,
      formData.contractData.propertyFloorArea,
      formData.contractData.propertyCondition
    )

    const clientInfoString = LOIhelpers.generateClientInfoString(
      formData.lesseeData.gender,
      formData.lesseeData.firstName,
      formData.lesseeData.lastName,
      formData.lesseeData.nationality,
      formData.lesseeData.status,
      formData.lesseeData.companyName,
      formData.lesseeData.designation,
      formData.lesseeData.companyAddress
    )

    const leasePeriodString = LOIhelpers.generateLeasePeriodString(
      minLeaseTermMonths,
      formData.contractData.leaseStartDate,
      formData.contractData.leaseStartDate
    )

    const advanceRentalString1 = LOIhelpers.generateAdvanceRentalString1(
      advanceRentalMonths,
      securityDepositMonths,
      formData.contractData.propertyPrice
    )

    const advanceRentalString2 = LOIhelpers.generateAdvanceRentalString2(
      formData.contractData.leaseStartDate,
      securityDepositMonths
    )

    const reservationItemsString1 = LOIhelpers.reservationItemsString1(
      securityDepositMonths,
      formData.contractData.reservationFeeAmount,
      formData.contractData.leaseStartDate
    )

    const reservationItemsString2 = LOIhelpers.reservationItemsString2(
      advanceRentalMonths,
      securityDepositMonths,
      formData.contractData.reservationFeeAmount
    )

    const shouldTheLessorFailString = formData.contractData.shouldTheLessorFail
      ? LOIhelpers.generateShouldTheLessorFailString()
      : ''

    // 2. Replace placeholders with form data
    htmlTemplate = htmlTemplate
      .replace(/{{generation-date}}/g, formatDate(new Date()))
      .replace(/{{recipient-string}}/g, recipientString)
      .replace(/{{property-info-string}}/g, propertyInfoString)
      .replace(/{{client-info-string}}/g, clientInfoString)
      .replace(/{{lease-period-string}}/g, leasePeriodString)
      .replace(/{{advance-rental-string1}}/g, advanceRentalString1)
      .replace(/{{advance-rental-string2}}/g, advanceRentalString2)
      .replace(/{{reservation-items-string1}}/g, reservationItemsString1)
      .replace(/{{reservation-items-string2}}/g, reservationItemsString2)
      .replace(/{{request-string}}/g, requestString)
      .replace(
        /{{should-the-lessor-fail-to-complete-string}}/g,
        shouldTheLessorFailString
      )
      .replace(
        /{{advance-rental-months}}/g,
        `${monthsToWords(formData.contractData.advanceRentalValue)} (${
          formData.contractData.advanceRentalValue
        })`
      )
      .replace(/{{monthly-rent}}/g, formData.contractData.propertyPrice)
      .replace(
        /{{valid-until-date}}/g,
        formatDate(formData.letterData.letterValidity)
      )
      .replace(
        /{{lessee-name}}/g,
        `${formData.lesseeData.firstName} ${formData.lesseeData.lastName}`
      )
      .replace(/{{lessor-name}}/g, `${formData.lessorData.contactPersonName}`)
    // Auth check: the server endpoint requires a session, but failing
    // here gives a clearer error than a 401 deep in the network stack.
    const user = useSupabaseUser()
    if (!user.value) throw new Error('User not authenticated')

    const lesseeName = `${formData.lesseeData.firstName ?? ''} ${
      formData.lesseeData.lastName ?? ''
    }`.trim()
    const lessorName = `${formData.lessorData?.contactPersonName ?? ''}`.trim()
    const documentName = `Residential Letter of Intent for Rent to ${
      lesseeName || 'Unknown'
    }`

    // Server generates the canonical DOCX, persists to S3 + documents
    // table, and emits a document.uploaded audit row. metadata threads
    // cross-entity links so the LOI surfaces in the linked listing's
    // timeline (and on a contact's timeline once the form learns to
    // pass contact_id).
    const result = await callGenerateDocx(htmlTemplate, documentName, {
      // propertyTitle.value is the listing id when a listing is selected.
      listing_id: formData.contractData?.propertyTitle?.value ?? null,
      lessee_name: lesseeName || null,
      lessor_name: lessorName || null,
      contact_id: formData.lessorData?.contact_id ?? null,
    })

    if (result.fileUrl) {
      downloadFromUrl(result.fileUrl, `${documentName}.docx`)
    }
    return result.fileUrl
  } catch (error) {
    console.error('LOI generation failed:', error)
    throw error
  }
}
