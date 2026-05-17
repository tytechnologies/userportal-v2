<template>
   <section class="flex fixed z-10 inset-0 overflow-y-auto select-none bg-foreground/55" aria-labelledby="modal-title" role="dialog" aria-modal="true" v-show="isVisible">


          <div class="h-auto md:m-auto border border-border border-solid shadow-xl  bg-card rounded-lg p-4 w-full md:max-w-lg" v-show="isVisible">
              <div class="pb-3"  v-if="isLoading">
                 <div class="-mt-4 -mx-4 h-1 rounded shim-blue"></div>
             </div>

               <!-- Title -->
               <div class="text-xl font-bold text-center mt-4">Download Photos</div>
               <div class="mb-6"></div>
               <!-- Listing name -->
               <div class="text-md font-black uppercase text-center mx-auto w-72">{{listing && listing.name}}</div>
               <!-- Location -->
               <div class="font-medium text-sm text-muted-foreground mb-4 text-center">
                  <span> {{listing.unit_number}} {{listing.street}} {{listing['city.name']}}</span>
               </div>
               <!-- Price -->
               <div class="bg-primary/10 flex justify-between pl-4 pr-1 py-1  rounded-l-full rounded-r-full w-52 mx-auto ">
                  <div class=" my-auto px-2 font-bold text-center w-auto">All Photos</div>
                  <div class=" px-4 py-2.5 font-bold text-center w-auto bg-primary rounded-l-full rounded-r-full text-white break-words">{{listing.formatted_fixed_image_price}}</div>
               </div>
              <div class="grid mx-auto w-72 mb-2 mt-12">
                <button type="button" class="w-full h-9 my-auto bg-green focus:bg-green hover:bg-green-dark rounded-lg mb-4"  @click="downloadAllImages(listing.name,1)" :disabled="isLoading">
                  <span class="inline-block text-white font-bold mt-0.5">Download {{listing.formatted_fixed_image_price}}</span>
                </button>
               <div class="text-center mb-4">
                  <a href="#" class="text-primary text-xs" @click="downloadAllImages(listing.name)" :disabled="isLoading">
                      Download all with watermarks
                  </a>
               </div> 
               <div class="text-center">
                  <a href="#" class="text-xs" @click="close">
                    Close
                  </a>
               </div> 
              </div>     
            </div>
   </section>
</template>

<script>
import { apiRoutes } from "~/contants";
import Modals from "~/mixins/modals";
import { formatCurrency } from '~/helpers/helpers';
// Icons
import Close from "vue-material-design-icons/Close.vue";
import { showLoading,dismissLoading,showToast } from "~/helpers/helpers";


export default {
  mixins: [Modals],
  props: {
    isModalOpen:{
      default:false,
    },
    listingId: {
      default: null,
    },
  },
  components: { Close },
  data() {
    return {
      isLoading:false,
      fileType:'zip',
      fileSize:'large',
      listing: {},
           singleListingUrl: apiRoutes['listings.show'],
    };
  },
  computed: {
      isVisible() {
      return !! this.isModalOpen;
    }
  },
  watch: {
    isModalOpen(isModalOpen) {
      if (!! isModalOpen) {
        if(!! this.listingId){
        this.getSingleListing(this.listingId);
        }
      } 
    }
  },
  methods: {
    downloadAllImages(name,isPaid = 0){
      if(this.isLoading){
        return true;
      }
      this.isLoading = true;
      showLoading();
      const body = {
         is_paid: isPaid,
         file_type: this.fileType,
         file_size: this.fileSize,
      }
      let options = {};
      // console.log(this.fileType);
      switch (this.fileType) {
        case 'zip':
          options = {responseType: 'arraybuffer'};
          break;
        default:
          options = {responseType: 'json'};
          break;
      }
      const remarks = isPaid ? '' : '_w_watermarks'; 
      this.$axios.$post(this.singleListingUrl.replace('/:id', `/${this.listingId}/download-all-images`),body,options)
          .then(res => {
            dismissLoading();
            this.isLoading = false;
            if(this.fileType === 'zip'){
              const filename = name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
              const downloadUrl = window.URL.createObjectURL(new Blob([res]));
              const link = document.createElement('a');
              link.href = downloadUrl;
              link.setAttribute('download', `listing_${filename}_${body.file_size}${remarks}.zip`);
              document.body.appendChild(link);
              link.click();
              link.remove();  
            }
          },()=>{
            dismissLoading();
            this.isLoading = false;
          });
      },
    close() {
          this.$emit('close');
    },
    getSingleListing(listingId = null) {
      if (!listingId) {
        return true;
      }
       showLoading();
       this.$axios
        .$get(this.singleListingUrl.replace('/:id', `/${listingId}`))
        .then((listingRes) => {
          dismissLoading();
          if(! parseInt(listingRes.watermark_agreement)){
            this.$emit('close');
          }
           let listing = listingRes ;
            /**
             * Preprocess
             */
            listing.metadata = JSON.parse(listing.metadata);
            listing['formatted_rent_price'] = formatCurrency(listing.rent_price || 0);
            listing['formatted_fixed_image_price'] = formatCurrency(listing.fixed_image_price || 0);
            this.listing = listing;
        },()=>{
            dismissLoading();
        });
    },
  },
};
</script>