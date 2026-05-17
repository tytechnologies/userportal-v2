import * as XLSX from 'xlsx'

/**
 * Reads an XLSX File object, edits some cells, and prompts download.
 * @param {File} file - The XLSX file uploaded by the user
 */
export async function generateGrossTaxReport(grossFormData) {
  //get gross_report.xlsx template from /public/tax-computations/gross_report.xlsx
  const template = await fetch(
    `${window.location.origin}/report-templates/gross_report.xlsx`
  )

  console.log('template: ', template)
  const arrayBuffer = await template.arrayBuffer()
  const workbook = XLSX.read(arrayBuffer, { type: 'array' })

  const sheetName = workbook.SheetNames[0]
  const worksheet = workbook.Sheets[sheetName]

  // Modify cells
  worksheet['D3'] = { t: 'n', v: grossFormData.gross }
  worksheet['D6'] = {
    t: 'n',
    z: '0.00%',
    v: `${grossFormData.capital_gain_tax / 100}%`,
  }

  worksheet['F6'] = {
    t: 'n',
    v: (grossFormData.capital_gain_tax / 100) * grossFormData.gross,
  }

  worksheet['D7'] = {
    t: 'n',
    z: '0.00%',
    v: `${grossFormData.commission / 100}%`,
  }
  worksheet['F7'] = {
    t: 'n',
    v: (grossFormData.commission / 100) * grossFormData.gross,
  }

  // Buyer side percentages
  worksheet['D12'] = {
    t: 'p',
    z: '0.00%',
    v: `${grossFormData.documentary_stamp_tax / 100}%`,
  }
  worksheet['D13'] = {
    t: 'p',
    z: '0.00%',
    v: `${grossFormData.transfer_tax / 100}%`,
  }
  worksheet['D14'] = {
    t: 'p',
    z: '0.00%',
    v: `${grossFormData.registration_fee / 100}%`,
  }
  worksheet['D15'] = {
    t: 'p',
    z: '0.00%',
    v: `${grossFormData.misc_fee / 100}%`,
  }
  worksheet['D16'] = {
    t: 'n',
    v: grossFormData.processing_fee,
  }

  // Buyer side values
  worksheet['F12'] = {
    t: 'n',
    v: (grossFormData.documentary_stamp_tax / 100) * grossFormData.gross,
  }
  worksheet['F13'] = {
    t: 'n',
    v: (grossFormData.transfer_tax / 100) * grossFormData.gross,
  }
  worksheet['F14'] = {
    t: 'n',
    v: (grossFormData.registration_fee / 100) * grossFormData.gross,
  }
  worksheet['F15'] = {
    t: 'n',
    v: (grossFormData.misc_fee / 100) * grossFormData.gross,
  }
  worksheet['F16'] = {
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
  a.download = 'gross_report.xlsx'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
