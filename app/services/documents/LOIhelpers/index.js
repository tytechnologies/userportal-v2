import { priceToWords, monthsToWords, formatDate } from '~/helpers/helpers'
export function generateRecipientString(
  gender,
  contactPersonName,
  propertyAddress,
  contactPersonDesignation
) {
  return `${gender == 'male' ? 'Mr.' : 'Ms.'} ${contactPersonName} <br/>
  ${propertyAddress} <br/>
  LESSOR/${contactPersonDesignation}`
}

export function generatePropertyInfoString(
  propertyTitle,
  floorArea,
  condition
) {
  return `
  ${propertyTitle} <br/>
  Floor Area: ${floorArea} sqm <br/>
  ${condition}
  `
}

export function generateClientInfoString(
  gender,
  firstName,
  lastName,
  nationality,
  status,
  companyName,
  designation,
  companyAddress
) {
  return `To: 
  ${gender == 'male' ? 'Mr.' : 'Ms.'} ${firstName} ${lastName}
  ${nationality}, ${status}
  ${companyName}
  ${designation}
  ${companyAddress}
  `
}

export function generateLeasePeriodString(
  minLeaseTermValue,
  leaseStartDate,
  leaseEndDate
) {
  return `
  The lease shall be for a period of ${monthsToWords(
    minLeaseTermValue
  )} (${minLeaseTermValue}) 
  commencing on ${formatDate(leaseStartDate)} up to ${formatDate(leaseEndDate)}
`
}

export function generateAdvanceRentalString1(
  advanceRentalValueInMonths,
  securityDepositValueInMonths,
  propertyPrice
) {
  return `
  ${monthsToWords(
    advanceRentalValueInMonths
  )} months advance rental and ${monthsToWords(
    securityDepositValueInMonths
  )} (${securityDepositValueInMonths}) months security deposit equivalent to ${priceToWords(
    propertyPrice
  )} (Php ${propertyPrice}).
  `
}

export function generateAdvanceRentalString2(
  leaseStartDate,
  securityDepositValueInMonths
) {
  return `
    Said payments shall be paid on or before the start of lease, ${formatDate(
      leaseStartDate
    )} except for the ${monthsToWords(
    securityDepositValueInMonths
  )} (${securityDepositValueInMonths}) months security deposit which will serve as reservation 
    fee and also shall form part of the ${monthsToWords(
      securityDepositValueInMonths
    )} (${securityDepositValueInMonths}) months security deposit 
  `
}

export function reservationItemsString1(
  securityDepositValueInMonths,
  reservationFeeAmount,
  leaseStartDate
) {
  return ` 
    Upon acceptance of the ${monthsToWords(
      securityDepositValueInMonths
    )} months security deposit amounting to 
    Php ${reservationFeeAmount} not later than ${formatDate(
    leaseStartDate
  )}, the LESSOR shall hold the property for the LESSEE 
    and shall no longer entertain any third party. 
  `
}

export function reservationItemsString2(
  advanceRentalValueInMonths,
  securityDepositValueInMonths,
  reservationFeeAmount
) {
  return ` 
    Should the LESSEE fail to pay the full balance of ${monthsToWords(
      advanceRentalValueInMonths
    )} (${advanceRentalValueInMonths}) months advance rental and remaining ${monthsToWords(
    securityDepositValueInMonths
  )} (${securityDepositValueInMonths}) months security deposit equivalent to Php ${reservationFeeAmount}, the ${monthsToWords(
    securityDepositValueInMonths
  )} (${securityDepositValueInMonths}) months security deposit that 
    served as the reservation fee shall be forfeited in favor of the LESSOR, as liquidated damages. 
    The LESSOR shall then be free to lease out the unit to any other third party.  
  `
}

export function generateShouldTheLessorFailString() {
  return `
  <p style="margin-top:25pt; text-align:justify">
    Should the LESSOR fail to complete above mentioned items in full on or before the start of lease, the one
			(1) month security deposit will be returned to the LESSEE not later than one (1) week after the start of
			lease, with the right to terminate the lease contract immediately.
  </p>
  `
}
