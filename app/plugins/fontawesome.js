import { library, config } from '@fortawesome/fontawesome-svg-core'
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'

//import specific icons
import {
  faUser,
  faCircleXmark,
  faList,
  faIdCard,
  faFile,
  faBuilding,
  faGlobe,
  faBars,
  faHourglassEnd,
  faBell,
  faGrip,
  faSortDown,
  faMagnifyingGlass,
  faChevronDown,
  faChevronUp,
  faCaretDown,
  faCaretUp,
  faCircle,
  faGear,
  faSliders,
  faXmark,
  faFilter,
  faTableColumns,
  faArrowUpFromBracket,
  faChevronCircleDown,
  faChevronCircleUp,
  faCheck,
  faChevronRight,
  faChevronLeft,
  faClipboardList,
} from '@fortawesome/free-solid-svg-icons'

// Import the CSS
import '@fortawesome/fontawesome-svg-core/styles.css'

// Prevent automatic CSS injection
config.autoAddCss = false
// You can add your icons directly in this plugin. See other examples for how you

// can add other styles or just individual icons.
library.add(
  faUser,
  faCircleXmark,
  faList,
  faIdCard,
  faFile,
  faBuilding,
  faGlobe,
  faBars,
  faHourglassEnd,
  faBell,
  faGrip,
  faSortDown,
  faMagnifyingGlass,
  faChevronDown,
  faChevronUp,
  faCaretDown,
  faCaretUp,
  faCircle,
  faGear,
  faSliders,
  faXmark,
  faFilter,
  faTableColumns,
  faArrowUpFromBracket,
  faChevronCircleDown,
  faChevronCircleUp,
  faCheck,
  faChevronRight,
  faChevronLeft,
  faClipboardList,
)

export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.vueApp.component('font-awesome-icon', FontAwesomeIcon)
})
