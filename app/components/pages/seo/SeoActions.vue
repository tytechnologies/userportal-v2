<template>
  <div>
    <div>
      <ul class="flex space-x-0.5" role="none">
        <li v-if="userHasPermissionTo('seo.upsert')">
          <NuxtLink :to="`/seo-form?id=${value}`" class="w-full h-6 px-2 text-sm text-primary text-left">
            <i class="fas fa-edit"></i>
          </NuxtLink>
        </li>
        <li v-if="userHasPermissionTo('seo.delete')">
          <button type="button" class="w-full h-6 px-2 text-sm text-primary text-left" @click="confirmDelete">
            <i class="fas fa-trash"></i>
          </button>
        </li>
      </ul>
    </div>

    <Alert v-model="showDeleteConfirmation" icon="success" @ok="destroy" confirm-button-text="Delete">
      <div class="text-center">
        <h3 class="text-lg text-foreground leading-6 font-medium">Confirm Delete</h3>
        <p class="text-lg text-muted-foreground/70 leading-6 font-medium">Do you really want to delete this?</p>
      </div>
    </Alert>
  </div>

</template>

<script>
  import Auth from "~/mixins/auth";
  import Alert from "~/components/CustomAlert.vue";
  import Close from 'vue-material-design-icons/Close.vue';
  import DotsVertical from 'vue-material-design-icons/DotsVertical.vue';
  import { apiRoutes } from "~/contants";
  // Icons
  import PencilOutline from 'vue-material-design-icons/PencilOutline.vue';
  import CloseCircle from 'vue-material-design-icons/CloseCircle.vue';
  import CheckCircle from 'vue-material-design-icons/CheckCircle.vue';
  import TrashCanOutline from 'vue-material-design-icons/TrashCanOutline.vue';
  import ArchiveOutline from 'vue-material-design-icons/ArchiveOutline.vue';
  export default {
    mixins: [Auth],
    props: {
      value: {
        type: [String, Number]
      },
      seo: {
        type: [Array]
      }
    },
    components: { Alert, Close, DotsVertical, PencilOutline, CloseCircle, CheckCircle, TrashCanOutline, ArchiveOutline },
    data() {
      return {
        data: {},
        showActions: false,
        showArchiveConfirmation: false,
        showDeleteConfirmation: false
      }
    },
    mounted() {
      this.data = this.seo;
    },
    methods: {
      close() {
        this.$emit('close');
      },
      hideActions() {
        this.showActions = false;
      },
      edit() {
        this.$emit('edit', this.value);
        this.hideActions();
      },

      confirmDelete() {
        this.showDeleteConfirmation = true;
        this.hideActions();
      },
      destroy() {
        this.showDeleteConfirmation = false;
        this.$axios.$delete(apiRoutes['seo.delete'].replace('/:id', `/${this.value}`))
          .then(() => {
            this.$emit('deleted');
            this.close();
          })
          .catch(() => {
            alert('Oops. Something went wrong. Please try again later.');
          });
      }
    }
  }
</script>