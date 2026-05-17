const HOST = `${process.env.API_URL}/api`
const cancelTokens = {}
import { apiRoutes } from '~/contants'
import { generateAuthorityToSell } from '~/services/documents/generateAuthorityToSell'
import { generateCommercialContractOfLease } from '~/services/documents/generateCommercialContractOfLease'
import { generateDeedOfAbsoluteSell } from '~/services/documents/generateDeedOfAbsoluteSell'
import { generateContractToSell } from '~/services/documents/generateContractToSell'
import { generateResidentialContractOfLease } from '~/services/documents/generateResidentialContractOfLease'
import { generateLOI } from '~/services/documents/generateLOI.js'
import { generatePropertyManagementAgreement } from '~/services/documents/generatePropertyManagementAgreement'
import { generateResidentialViewingList } from '~/services/documents/generateResidentialViewingList'
import { getViewingLists } from '~/services/documents/getViewingLists'
export const generateResidentialContractOfLeaseCall = async (form) => {
  return generateResidentialContractOfLease(form)
}

export const generateAuthorityToSellCall = async (form) => {
  return generateAuthorityToSell(form)
}

export const generatePropertyManagementAgreementCall = async (form) => {
  return generatePropertyManagementAgreement(form)
}

export const generateCommercialContractOfLeaseCall = async (form) => {
  return generateCommercialContractOfLease(form)
}

export const generateDeedOfAbsoluteSellCall = async (form) => {
  return generateDeedOfAbsoluteSell(form)
}

export const generateContractOfLeaseCall = async (form) => {
  // return generateContractOfLease(form)
}

export const generateContractToSellCall = async (form) => {
  return generateContractToSell(form)
}

export const generateLOICall = async (form) => {
  return generateLOI(form)
}

export const getDocumentsCall = async () => {
  // Migrated to /api/documents (DB-backed); legacy raw-S3 lister was deleted.
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const res = await fetch(`${origin}/api/documents/list`)
  if (!res.ok) throw new Error('Failed to load documents')
  return res.json()
}

export const getViewingListsCall = async () => {
  return getViewingLists()
}

export const generateResidentialViewingListCall = async (form) => {
  return generateResidentialViewingList(form)
}

export const generateDocxCall = async (form) => {
  const response = await fetch(`/api/documents/generate-docx`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Andrei',
      age: 30,
    }),
  })
  return response.json()
}

/** Delete document by DB id (removes from S3 and DB). Use for documents stored in `documents` table. */
export const removeDocumentByIdCall = async (documentId) => {
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const res = await fetch(`${origin}/api/documents/${documentId}`, { method: 'DELETE' })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err?.statusMessage || err?.message || res.statusText || 'Failed to delete document')
  }
  return res.json()
}

export const getDocumentDocxCall = async (docName) => {
  if (docName.includes('Residential Letter of Intent for Rent')) {
    const templateName = 'Residential LOI for Rent to FIRST NAME LAST NAME'
    const docxObject = await fetch(`/documents-docx/${templateName}.docx`)
    const docxBlob = await docxObject.blob()
    return { docxBlob, templateName }
  }
  if (docName.includes('Residential Property Management')) {
    const templateName = 'Residential Property Management to Owner Name'
    const docxObject = await fetch(`/documents-docx/${templateName}.docx`)
    const docxBlob = await docxObject.blob()
    return { docxBlob, templateName }
  }
  if (docName.includes('Commercial Contract of Lease')) {
    const templateName = 'Commercial Contract of Lease to Representative Name'
    const docxObject = await fetch(`/documents-docx/${templateName}.docx`)
    const docxBlob = await docxObject.blob()
    return { docxBlob, templateName }
  }
  if (docName.includes('Residential Authority to Sell')) {
    const templateName = 'Residential Authority to Sell to Owner Name'
    const docxObject = await fetch(`/documents-docx/${templateName}.docx`)
    const docxBlob = await docxObject.blob()
    return { docxBlob, templateName }
  }
  if (docName.includes('Residential Contract of Lease')) {
    const templateName = 'Residential Contract of Lease to FULL NAME'
    const docxObject = await fetch(`/documents-docx/${templateName}.docx`)
    const docxBlob = await docxObject.blob()
    return { docxBlob, templateName }
  }
  if (docName.includes('Residential Contract to Sell')) {
    const templateName = 'Residential Contract to Sell to FULL NAME'
    const docxObject = await fetch(`/documents-docx/${templateName}.docx`)
    const docxBlob = await docxObject.blob()
    return { docxBlob, templateName }
  }
  if (docName.includes('Residential Deed of Sale')) {
    const templateName = 'Residential Deed of Sale to FULL NAME'
    const docxObject = await fetch(`/documents-docx/${templateName}.docx`)
    const docxBlob = await docxObject.blob()
    return { docxBlob, templateName }
  }
}

export default {
  methods: {
    generateCancelToken(cancelTokenName) {
      cancelTokens[cancelTokenName] = this.$axios.CancelToken.source()
    },

    getCancelToken(tokenName) {
      if (cancelTokens[tokenName] != undefined) {
        cancelTokens[tokenName].cancel()
      }

      this.generateCancelToken(tokenName)

      return cancelTokens[tokenName].token
    },

    _getDocuments(params = '') {
      //const token = this.getCancelToken('getDocumentReports');
      // console.log(params)
      return $fetch(apiRoutes['documents.report'] + `${params}`)
    },
  },
}
