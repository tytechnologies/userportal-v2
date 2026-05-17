import { callGenerateDocx, downloadFromUrl, escapeHtml } from './_helpers'

// Residential Contract of Lease generator. Server emits the canonical
// DOCX; metadata threads cross-entity links so the doc surfaces in the
// linked listing's / contact's unified timeline.

export const generateResidentialContractOfLease = async (formData) => {
  try {
    const origin = window.location.origin

    const response = await fetch(
      `${origin}/document-templates/Residential Contract of Lease to FULL NAME.html`
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

    // Defaults for every interpolated field — the template assumes every
    // placeholder is non-empty. NULL values used to render the literal
    // word "undefined" or empty cells in the resulting DOCX.
    const r = {
      contractDay:                   formData.contractData?.contractDay      || '1',
      contractMonth:                 formData.contractData?.contractMonth    || 'January',
      contractYear:                  formData.contractData?.contractYear     || '2024',
      contractCity:                  formData.contractData?.contractCity     || 'Manila',
      lessorName:                    formData.lessorDetails?.lessor_name        || 'Unknown Lessor',
      lessorNationality:             formData.lessorDetails?.lessor_nationality || 'Filipino',
      lessorMaritalStatus:           formData.lessorDetails?.lessor_civil_status || 'Single',
      lessorAddress:                 formData.lessorDetails?.lessor_address     || 'Manila, Philippines',
      lesseeName:                    formData.lesseeDetails?.lessee_name        || 'Unknown Lessee',
      lesseeNationality:             formData.lesseeDetails?.lessee_nationality || 'Filipino',
      lesseeMaritalStatus:           formData.lesseeDetails?.lessee_civil_status || 'Single',
      lesseeAddress:                 formData.lesseeDetails?.lessee_address     || 'Manila, Philippines',
      propertyAddress:               formData.propertyDetails?.name             || 'Unknown Property',
      propertyCity:                  formData.propertyDetails?.city             || 'Manila',
      leasePeriod:                   formData.propertyDetails?.lease_term       || '12 months',
      leaseStartDate:                formData.propertyDetails?.lease_starting_date || 'January 1, 2024',
      leaseEndDate:                  formData.contractData?.leaseEndDate        || 'December 31, 2024',
      renewalNoticePeriod:           formData.contractData?.renewalNoticePeriod || '30 days',
      rentalPrice:                   formData.propertyDetails?.price            || '0',
      rentalPaymentDate:             formData.contractData?.rentalPaymentDate   || '5th day of each month',
      securityDeposit:               formData.propertyDetails?.deposit          || '0',
      securityDepositReturnPeriod:   formData.contractData?.securityDepositReturnPeriod || '30 days',
      advanceRentalMonths:           formData.propertyDetails?.advance          || '1',
      securityDepositMonths:         formData.propertyDetails?.deposit_unit     || '1',
      postDatedCheques:              formData.contractData?.postDatedCheques    || 'Yes',
      totalPayment:                  formData.contractData?.totalPayment        || '0',
      utilities:                     formData.contractData?.utilities           || 'Tenant pays',
      majorRepairExpenditure:        formData.contractData?.majorRepairExpenditure || 'Landlord responsible',
      minorRepairExpenditure:        formData.contractData?.minorRepairExpenditure || 'Tenant responsible',
      attorneyFees:                  formData.contractData?.attorneyFees        || 'Each party pays their own',
      attorneyFeesMinimum:           formData.contractData?.attorneyFeesMinimum || '0',
    }

    htmlTemplate = htmlTemplate
      .replace(/{{contractDay}}/g,                  escapeHtml(r.contractDay))
      .replace(/{{contractMonth}}/g,                escapeHtml(r.contractMonth))
      .replace(/{{contractYear}}/g,                 escapeHtml(r.contractYear))
      .replace(/{{contractCity}}/g,                 escapeHtml(r.contractCity))
      .replace(/{{lessorName}}/g,                   escapeHtml(r.lessorName))
      .replace(/{{lessorNationality}}/g,            escapeHtml(r.lessorNationality))
      .replace(/{{lessorMaritalStatus}}/g,          escapeHtml(r.lessorMaritalStatus))
      .replace(/{{lessorAddress}}/g,                escapeHtml(r.lessorAddress))
      .replace(/{{lesseeName}}/g,                   escapeHtml(r.lesseeName))
      .replace(/{{lesseeNationality}}/g,            escapeHtml(r.lesseeNationality))
      .replace(/{{lesseeMaritalStatus}}/g,          escapeHtml(r.lesseeMaritalStatus))
      .replace(/{{lesseeAddress}}/g,                escapeHtml(r.lesseeAddress))
      .replace(/{{propertyAddress}}/g,              escapeHtml(r.propertyAddress))
      .replace(/{{propertyCity}}/g,                 escapeHtml(r.propertyCity))
      .replace(/{{leasePeriod}}/g,                  escapeHtml(r.leasePeriod))
      .replace(/{{leaseStartDate}}/g,               escapeHtml(r.leaseStartDate))
      .replace(/{{leaseEndDate}}/g,                 escapeHtml(r.leaseEndDate))
      .replace(/{{renewalNoticePeriod}}/g,          escapeHtml(r.renewalNoticePeriod))
      .replace(/{{rentalPrice}}/g,                  escapeHtml(r.rentalPrice))
      .replace(/{{rentalPaymentDate}}/g,            escapeHtml(r.rentalPaymentDate))
      .replace(/{{securityDeposit}}/g,              escapeHtml(r.securityDeposit))
      .replace(/{{securityDepositReturnPeriod}}/g,  escapeHtml(r.securityDepositReturnPeriod))
      .replace(/{{advanceRentalMonths}}/g,          escapeHtml(r.advanceRentalMonths))
      .replace(/{{securityDepositMonths}}/g,        escapeHtml(r.securityDepositMonths))
      .replace(/{{postDatedCheques}}/g,             escapeHtml(r.postDatedCheques))
      .replace(/{{totalPayment}}/g,                 escapeHtml(r.totalPayment))
      .replace(/{{utilities}}/g,                    escapeHtml(r.utilities))
      .replace(/{{majorRepairExpenditure}}/g,       escapeHtml(r.majorRepairExpenditure))
      .replace(/{{minorRepairExpenditure}}/g,       escapeHtml(r.minorRepairExpenditure))
      .replace(/{{attorneyFees}}/g,                 escapeHtml(r.attorneyFees))
      .replace(/{{attorneyFeesMinimum}}/g,          escapeHtml(r.attorneyFeesMinimum))

    const documentName = `Residential Contract of Lease to ${r.lesseeName}`
    const result = await callGenerateDocx(htmlTemplate, documentName, {
      listing_id: formData.propertyDetails?.id ?? formData.propertyDetails?.listing_id ?? null,
      lessor_name: r.lessorName,
      lessee_name: r.lesseeName,
      contact_id:
        formData.lessorDetails?.contact_id ??
        formData.lesseeDetails?.contact_id ??
        null,
    })

    if (result.fileUrl) downloadFromUrl(result.fileUrl, `${documentName}.docx`)
    return result.fileUrl
  } catch (error) {
    console.error('Residential Contract of Lease generation failed:', error)
    throw error
  }
}
