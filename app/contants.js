export const hiAddress = '6th floor LDM Building, Polaris St. Makati City'
export const hiTelephone = '(632) 7759-2026'

export const apiRoutes = {
  'designations.registrable': 'api/designations/registrable',
  'designations.assignable': 'api/designations/assignable',
  'public.properties.show': 'api/public/properties/:id',
  'public.inquiries': 'api/public/inquiries',
  dashboard: 'api/dashboard',
  listings: 'api/properties',
  'listings.archives': 'api/properties/archives',
  'listings.outdated': 'api/properties/outdated',
  'listings.store': 'api/properties/store',
  'listings.selections': 'api/properties/selections',
  'listings.images': 'api/properties/:id/images',
  'listings.show': 'api/properties/:id',
  'listings.duplicate': 'api/properties/:id/duplicate',
  'listings.update': 'api/properties/:id',
  'listings.mark-as-online': 'api/properties/:id/online',
  'listings.archive': 'api/properties/:id/archive',
  'listings.unarchive': 'api/properties/:id/unarchive',
  'listings.delete': 'api/properties/:id',
  'listings.log.selections': 'api/properties/log/selections',
  'listings.log': 'api/properties/log',
  'listings.logs': 'api/properties/log/:id',
  'listings.visit.stats': 'api/properties/visit/stats',
  'listings.deck': 'api/properties/deck/list',
  'listings.deck.add': 'api/properties/deck/add',
  'listings.deck.remove': 'api/properties/deck/remove',
  'listings.export': 'api/properties/export',
  'listings.history': 'api/properties/history/',
  'listings.downloadImages': 'api/properties//:id/download-all-images',
  'generateCommercial.report': 'api/properties/generateCommercial/report',
  'divisions.show': 'api/divisions/:id',
  'cities.show': 'api/cities/:id',
  properties: 'api/properties',
  buildings: 'api/buildings',
  'buildings.filter': 'api/buildings/filter',
  'buildings.store': 'api/buildings',
  'buildings.show': 'api/buildings/:id',
  'buildings.delete': 'api/buildings/:id',
  'buildings.update': 'api/buildings/:id',
  developers: 'api/developers',
  'developers.store': 'api/developers',
  telcos: 'api/telcos',
  'telcos.store': 'api/telcos',
  'documents.selections': 'api/documents/selections',
  'documents.residential.letter-of-intent.rent':
    'api/documents/residential/letter-of-intent/rent',
  'documents.residential.letter-of-intent.sale':
    'api/documents/residential/letter-of-intent/sale',
  'documents.residential.contract-of-lease':
    'api/documents/residential/contract-of-lease',
  'documents.residential.deed-of-absolute-sale':
    'api/documents/residential/deed-of-absolute-sale',
  'documents.residential.contract-to-sell':
    'api/documents/residential/contract-to-sell',
  'documents.residential.authority-to-sell':
    'api/documents/residential/authority-to-sell',
  'documents.residential.property-management':
    'api/documents/residential/property-management',
  'documents.commercial.letter-of-intent.rent':
    'api/documents/commercial/letter-of-intent/rent',
  'documents.commercial.letter-of-intent.sale':
    'api/documents/commercial/letter-of-intent/sale',
  'documents.commercial.contract-of-lease':
    'api/documents/commercial/contract-of-lease',
  'documents.tax-computation.generate':
    'api/documents/tax-computation/generate',
  'documents.delete': 'api/documents/:id',
  'document.reports': '/api/documents/reports',
  contacts: 'api/contacts',
  'contact.list': 'api/contacts/list',
  'contacts.store': 'api/contacts/store',
  'contacts.show': 'api/contacts/:id',
  'contacts.update': 'api/contacts/:id',
  'contacts.delete': 'api/contacts/:id',
  'contacts.getAll': 'api/contacts/getAll/:id',
  'contacts.merge': 'api/contacts/merge/:id',
  'contacts.transferListings': 'api/contacts/transfer/:id/:idto',
  seo: 'api/seo',
  'seo.store': 'api/seo/store',
  'seo.show': 'api/seo/:id',
  'seo.update': 'api/seo/:id',
  'seo.delete': 'api/seo/:id',
  inquiries: 'api/inquiries',
  'inquiries.show': 'api/inquiries/:id',
  viewingList: 'api/viewing-list',
  'generate.residential.report': 'api/documents/residential/report',
  'generate.commercial.report': 'api/documents/commercial/report',
  'documents.report': 'api/documents',
  suggestions: 'api/suggestions',
  notifications: 'api/notifications',
  'notifications.status': 'api/notifications/status',
  latest_notifications: 'api/notifications/latest',
}

// const routes = [
//   {
//     name: 'home',
//     path: '/',
//     redirect: { name: 'login' }
//   },
//   {
//     name: 'login',
//     path: '/login',
//     component: Login
//   },
//   {
//     name: 'register',
//     path: '/register',
//     component: Register
//   },
//   {
//     name: 'forgotPassword',
//     path: '/forgot-password',
//     component: ForgotPassword
//   },
//   {
//     name: 'listing-preview',
//     path: '/property/:slug([A-Za-z-0-9]+[^-0-9.]+)-:id([0-9]+)',
//     component: ListingPreview
//   },
//   {
//     name: 'dashboard',
//     path: '/dashboard',
//     component: Dashboard
//   },
//   {
//     name: 'listings',
//     path: '/listings',
//     component: Listings
//   },
//   {
//     name: 'archives',
//     path: '/listings/archives',
//     component: Archives
//   },
//   {
//     name: 'outdated',
//     path: '/listings/outdated',
//     component: Outdated
//   },
//   {
//     name: 'listing',
//     path: '/listing/:id([0-9]+)',
//     component: Listing
//   },
//   {
//     name: 'listing-history',
//     path: '/listing/history/:id([0-9]+)',
//     component: ListingHistory
//   },
//   {
//     name: 'buildings',
//     path: '/buildings',
//     component: Buildings
//   },
//   {
//     name: 'building-preview',
//     path: '/building/:slug([A-Za-z-0-9]+[^-0-9.]+)-:id([0-9]+)',
//     component: BuildingPreview
//   },
//   {
//     name: 'documents',
//     path: '/checklists',
//     component: DocumentTabs
//   },
//   {
//     name: 'tax-computation',
//     path: '/tax-computation',
//     component: TaxComputation
//   },
//   {
//     name: 'viewing-lists',
//     path: '/viewing-lists',
//     component: ViewingLists
//   },
//   {
//     name: 'document-lists',
//     path: '/document-lists',
//     component: Contracts
//   },
//   {
//     name: 'residential-lists',
//     path: '/residential-lists',
//     component: ResidentialContracts
//   },
//   {
//     name: 'commercial-lists',
//     path: '/commercial-lists',
//     component: CommercialContracts
//   },
//   {
//     name: 'generate-documents',
//     path: '/generate-documents',
//     component: GenerateDocuments
//   },
//   {
//     name: 'contacts',
//     path: '/contacts',
//     component: Contacts
//   },
//   {
//     name: 'contact',
//     path: '/contact/:id([0-9]+)',
//     component: Contact
//   },
//   {
//     name: 'seo',
//     path: '/seo',
//     component: Seo
//   },
//   {
//     name: 'addSeo',
//     path: '/add-seo',
//     component: SeoForm
//   },
//   {
//     name: 'updateSeo',
//     path: '/update-seo',
//     component: SeoForm
//   },
//   {
//     name: 'overview',
//     path: '/overview',
//     component: Overview
//   },
//   {
//     name: 'propertyOverview',
//     path: '/overview/:id([0-9]+)',
//     component: Overview
//   },
//   {
//     name: 'termsAndConditions',
//     path: '/terms-and-conditions',
//     component: TermsAndConditions
//   },
//   {
//     name: 'privacyPolicy',
//     path: '/privacy-policy',
//     component: PrivacyPolicy
//   },
//   {
//     name: 'deck',
//     path: '/deck',
//     component: Deck
//   }
// ]
