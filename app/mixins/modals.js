
let documentOverflow, documentPaddingRight, documentScrollBarWidth;

export default {
  computed: {
    isVisible() {
      return false;
    }
  },
  watch: {
    isVisible(value) {
      if (value) {
        documentOverflow = document.documentElement.style.overflow
        documentPaddingRight = document.documentElement.style.paddingRight

        documentScrollBarWidth = window.innerWidth - document.documentElement.clientWidth

        document.documentElement.style.overflow = 'hidden'
        document.documentElement.style.paddingRight = `${documentScrollBarWidth}px`
      } else {
        document.documentElement.style.overflow = documentOverflow;
        document.documentElement.style.paddingRight = documentPaddingRight;
      }
    }
  },
}
