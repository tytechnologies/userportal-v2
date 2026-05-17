<template>
  <div class="h-full flex gap-4">
    <aside
      class="checklist-aside lg:w-1/3 w-full h-full flex flex-col bg-card px-6 py-8 gap-2"
    >
      <div
        class="flex-1 scrollbar-thin scrollbar-thumb-black-10 scrollbar-thumb-rounded-full overflow-y-auto"
      >
        <ul>
          <li class="flex justify-between font-bold mb-4">
            <div>
              <span class="mx-5"> Status </span>
              <span> Checklist </span>
            </div>
            <div class="mr-2 text-primary">
              {{ completed }}/{{ counter }} Complete
            </div>
          </li>
          <li
            v-for="(document, index) in documents"
            @click="selectedDocument = index"
            v-bind:key="index"
            class="min-h-12 flex font-medium mb-2 px-6 py-2.5 cursor-pointer justify-start"
            :class="[
              selectedDocument === index ? 'text-primary bg-primary/10' : '',
              index % 2 == 0
                ? 'text-foreground bg-muted/50 hover:bg-muted'
                : '',
            ]"
          >
            <span class="inline-block my-2 ml-3 mr-5">
              <!-- @click="completed++" -->
              <input type="checkbox" v-model="document.isChecked" />
            </span>
            <span class="inline-block leading-5 my-auto ml-5">{{
              document.title
            }}</span>
          </li>
        </ul>
        <div class="text-center mt-4 flex gap-2">
          <button
            type="button"
            @click="$emit('prev')"
            class="w-39 h-9 my-auto bg-green hover:bg-green-dark rounded-lg"
            :class="
              isDisabled
                ? 'bg-opacity-20 hover:bg-opacity-30 text-green'
                : 'text-white'
            "
            v-if="step > 0"
          >
            Prev
          </button>
          <button
            type="button"
            @click="$emit('next')"
            class="w-39 h-9 my-auto bg-green hover:bg-green-dark rounded-lg"
            :class="
              isDisabled
                ? 'bg-opacity-20 hover:bg-opacity-30 text-green'
                : 'text-white'
            "
          >
            Step {{ step + 1 }}
          </button>
        </div>
      </div>
    </aside>
    <div
      class="checklist-content flex-1 p-4 hidden lg:block"
      :class="!!image ? 'bg-muted' : 'bg-card'"
    >
      <div v-if="!!image" class="h-full">
        <img
          :src="image"
          alt="Document"
          class="w-auto h-full object-contain mx-auto"
        />
      </div>
      <div v-else class="h-full flex">
        <div class="m-auto">
          <DocumentChecklist class="mx-auto mb-3" />
          <span class="block text-foreground font-bold mx-auto text-center"
            >No document selected</span
          >
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import DocumentChecklist from '~/components/svg/DocumentChecklist'

export default {
  props: {
    documents: {
      default: [],
    },
    step: {
      default: 1,
    },
  },
  components: { DocumentChecklist },
  data() {
    return {
      completed: 0,

      selectedDocument: null,
    }
  },
  mounted() {
    this.documents.map((res, index) => {
      this.documents[index].isChecked = false
    })
  },
  watch: {
    documents: {
      deep: true,
      handler() {
        const counts = this.documents.filter(
          (value) => value.isChecked === true
        ).length
        this.completed = counts
      },
    },
  },
  computed: {
    image() {
      return this.selectedDocument !== null
        ? `/img/documents/${this.documents[this.selectedDocument]['image']}`
        : `/img/documents/${this.documents[0]['image']}`
    },
    counter() {
      return this.documents.length
    },
    isDisabled() {
      return this.documents.length == this.completed ? false : true
    },
  },
}
</script>
