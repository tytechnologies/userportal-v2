// Simple validation rules
export const validationRules = {
  string: {
    validate: (value) => typeof value === 'string' || typeof value === 'number',
    sanitize: (value) => String(value).trim(),
    isEmpty: (value) =>
      value === null || value === undefined || String(value).trim() === '',
  },
  number: {
    validate: (value) =>
      typeof value === 'number' ||
      (typeof value === 'string' && !isNaN(Number(value))),
    sanitize: (value) => (typeof value === 'string' ? Number(value) : value),
    isEmpty: (value) =>
      value === null ||
      value === undefined ||
      value === '' ||
      isNaN(Number(value)),
  },
  array: {
    validate: (value) => Array.isArray(value),
    sanitize: (value) => (Array.isArray(value) ? value : []),
    isEmpty: (value) => !Array.isArray(value) || value.length === 0,
  },
  boolean: {
    validate: (value) => typeof value === 'boolean',
    sanitize: (value) => Boolean(value),
    isEmpty: (value) => value === null || value === undefined,
  },
}

// All required fields configuration - validates everything at once
export const requiredFieldsConfig = {
  // Basic listing info
  property_category: {
    type: 'string',
    required: true,
    message: 'Category is required',
    enum: ['residential', 'commercial'],
  },
  property_id: {
    type: 'string',
    required: false,
    message: 'Property is required',
  },
  building_type: {
    type: 'string',
    required: true,
    message: 'Building type is required',
  },
  city_name: {
    type: 'string',
    required: true,
    message: 'City is required',
  },
  barangay_name: {
    type: 'string',
    required: false,
    message: 'Area is required',
  },
  barangay_id: {
    type: 'number',
    required: (form) => form.property_category && !form.property_id, // Required for non-building types
    message: 'Barangay is required for non-building properties',
  },
  street_address: {
    type: 'string',
    required: true,
    message: 'Street address is required',
  },
  contact_id: {
    type: 'string',
    required: true,
    message: 'Please select a contact',
  },

  // Listing details
  unit_number: {
    type: 'string',
    required: false,
    message: 'Unit number is required',
    minLength: 1,
    maxLength: 100,
  },
  title: {
    type: 'string',
    required: true,
    message: 'Listing title is required',
    minLength: 5,
    maxLength: 200,
  },
  availability_date: {
    type: 'string',
    required: true,
    message: 'Availability date is required',
  },

  // Pricing - conditional based on listing type
  rent_price: {
    type: 'number',
    required: (form) => form.for_rent === 1,
    message: 'Rental price is required',
    min: 0,
  },
  rent_price_per_sqm: {
    type: 'number',
    required: false,
    message: 'Rental price per sqm is optional',
    min: 0,
  },
  sale_price: {
    type: 'number',
    required: (form) => form.for_sale === 1,
    message: 'Sale price is required',
    min: 0,
  },
  sale_price_per_sqm: {
    type: 'number',
    required: false,
    message: 'Sale price per sqm is optional',
    min: 0,
  },

  // Property attributes
  floor_area: {
    type: 'number',
    required: true,
    message: 'Floor area is required',
    min: 0,
  },
  condition: {
    type: 'string',
    required: true,
    message: 'Property condition is required',
  },

  // Rental specific fields
  advance: {
    type: 'number',
    required: false,
    message: 'Advance rental is required',
    min: 1,
  },
  advance_unit: {
    type: 'string',
    required: false,
    message: 'Advance rental unit is required',
  },
  deposit: {
    type: 'number',
    required: false,
    message: 'Security deposit is required',
    min: 1,
  },
  deposit_unit: {
    type: 'string',
    required: false,
    message: 'Security deposit unit is required',
  },
  minimum_lease_term: {
    type: 'number',
    required: false,
    message: 'Minimum lease term is required',
    min: 1,
  },
  minimum_lease_term_unit: {
    type: 'string',
    required: (form) => form.for_rent === 1,
    message: 'Minimum lease term unit is required',
  },

  // Residential specific fields
  bedrooms: {
    type: 'number',
    required: false,
    message: 'Number of bedrooms is required',
    min: 0,
  },
  bathrooms: {
    type: 'number',
    required: false,
    message: 'Number of bathrooms is required',
    min: 0,
  },

  // Common fields
  parking_spaces: {
    type: 'number',
    required: false,
    message: 'Number of parking spaces is required',
    min: 0,
  },

  // Commercial specific fields
  commercial_building_class: {
    type: 'string',
    required: false,
    message: 'Building class is required for commercial properties',
  },
  commercial_developer: {
    type: 'string',
    required: false,
    message: 'Developer is required for commercial properties',
  },
  commercial_office_floor: {
    type: 'string',
    required: false,
    message: 'Office floor is required for serviced office',
  },
  commercial_occupant_number: {
    type: 'number',
    required: false,
    message: 'Number of occupants is required for serviced office',
    min: 1,
  },
  commercial_office_type: {
    type: 'string',
    required: false,
    message: 'Office space type is required for serviced office',
  },
  commercial_office_setup: {
    type: 'string',
    required: false,
    message: 'Office setup is required for serviced office',
  },
}

// Validate a single field
export const validateField = (field, value, config, form) => {
  const errors = []
  const rule = validationRules[config.type]

  // Check if field is required
  const isRequired =
    typeof config.required === 'function'
      ? config.required(form)
      : config.required

  if (isRequired && rule.isEmpty(value)) {
    errors.push(config.message)
    return errors
  }

  // If field is not required and empty, skip other validations
  if (!isRequired && rule.isEmpty(value)) {
    return errors
  }

  // Type validation
  if (!rule.validate(value)) {
    errors.push(`Invalid ${field} format`)
    return errors
  }

  // Sanitize value
  const sanitizedValue = rule.sanitize(value)

  // Length validations
  if (config.minLength && sanitizedValue.length < config.minLength) {
    errors.push(`${field} must be at least ${config.minLength} characters`)
  }
  if (config.maxLength && sanitizedValue.length > config.maxLength) {
    errors.push(`${field} must not exceed ${config.maxLength} characters`)
  }

  // Number range validations
  if (config.type === 'number') {
    if (config.min !== undefined && sanitizedValue < config.min) {
      errors.push(`${field} must be at least ${config.min}`)
    }
    if (config.max !== undefined && sanitizedValue > config.max) {
      errors.push(`${field} must not exceed ${config.max}`)
    }
  }

  // Enum validation
  if (config.enum && !config.enum.includes(sanitizedValue)) {
    errors.push(`Invalid ${field} value`)
  }

  return errors
}

// Main validation function - validates all required fields at once
export const validateForm = (formData) => {
  const errors = {}

  console.log('🔍 Validating entire form with data:', formData)

  Object.entries(requiredFieldsConfig).forEach(([field, config]) => {
    console.log(`🔍 Validating field: ${field}`)
    console.log(`   Config:`, config)
    console.log(`   Value:`, formData[field])

    const fieldErrors = validateField(field, formData[field], config, formData)
    if (fieldErrors.length > 0) {
      errors[field] = fieldErrors[0] // Use first error message
      console.log(`❌ Field ${field} has errors:`, fieldErrors)
    } else {
      console.log(`✅ Field ${field} passed validation`)
    }
  })

  // Special validations
  if (!formData.for_sale && !formData.for_rent) {
    errors.listing_type =
      'Please select at least one listing type (Sale or Rent)'
    console.log('❌ No listing type selected (sale or rent)')
  }

  console.log(`📊 Final validation errors:`, errors)
  return errors
}

// Legacy function for backward compatibility (if needed)
export const validateStep = (step, formData) => {
  console.warn('validateStep is deprecated. Use validateForm instead.')
  return validateForm(formData)
}
