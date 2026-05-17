import * as XLSX from 'xlsx'

/**
 * Reads an XLSX File object, edits some cells, and prompts download.
 * @param {File} file - The XLSX file uploaded by the user
 */
export async function generateNettZVTaxReport(grossFormData) {
  //get gross_report.xlsx template from /public/tax-computations/gross_report.xlsx
  const template = await fetch(
    `${window.location.origin}/report-templates/nettzv_report.xlsx`
  )

  console.log('template: ', template)
  const arrayBuffer = await template.arrayBuffer()
  const workbook = XLSX.read(arrayBuffer, { type: 'array' })

  const sheetName = workbook.SheetNames[0]
  const worksheet = workbook.Sheets[sheetName]

  // Modify cells
  worksheet['C4'] = { t: 'n', v: grossFormData.zvp }
  worksheet['C5'] = {
    t: 'n',
    v: grossFormData.selling_price,
  }
  worksheet['C6'] = {
    t: 'n',
    v: `${grossFormData.capital_gain_tax}%`,
  }
  worksheet['C7'] = {
    t: 'n',
    v: `${grossFormData.commission}%`,
  }

  worksheet['C10'] = {
    t: 'n',
    v: `${grossFormData.documentary_stamp_tax}%`,
  }
  worksheet['C13'] = {
    t: 'n',
    v: `${grossFormData.transfer_tax}%`,
  }
  worksheet['C14'] = {
    t: 'n',
    v: `${grossFormData.registration_fee}%`,
  }
  worksheet['C15'] = {
    t: 'n',
    v: `${grossFormData.misc_fee}%`,
  }
  worksheet['C16'] = {
    t: 'n',
    v: grossFormData.processing_fee,
  }

  // Update range
  const range = XLSX.utils.decode_range(worksheet['!ref'])
  range.e.r = Math.max(range.e.r, 2) // row 2 = C3
  range.e.c = Math.max(range.e.c, 2) // col 2 = C
  worksheet['!ref'] = XLSX.utils.encode_range(range)

  // Export updated file as Blob
  const updatedXLSX = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' })
  const blob = new Blob([updatedXLSX], { type: 'application/octet-stream' })

  // Trigger download
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'nett_zv_report.xlsx'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
