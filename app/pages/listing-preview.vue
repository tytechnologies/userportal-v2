<template>
  <div class="bg-muted p-6">
    
    <div class="lg:flex p-3">
        <div class="lg:w-2/3 lg:pr-6">
            <h1 class="text-2xl font-bold text-black">{{ property.name }}</h1>
            <p class="text-muted-foreground text-sm mt-1"><i class="fas fa-location-dot"></i>&nbsp;{{ address }}</p>
        </div>
        <div class="lg:w-1/3 lg:pl-6 sm:mt-3 md:mt-3">
            <div class="grid grid-cols-2">
                <div v-show="property.is_for_rent">
                    <h5 class="text-muted-foreground font-bold text-sm">Rental Price</h5>
                    <h2 class="text-xl text-black mt-1">{{ rentalPrice }}</h2>
                    <p class="text-muted-foreground text-sm">{{ rentalPricePsqm }}</p>
                </div>

                <div v-show="property.is_for_sale">
                    <h5 class="text-muted-foreground font-bold text-sm">Price</h5>
                    <h2 class="text-xl text-black mt-1">{{ salePrice }}</h2>
                    <p class="text-muted-foreground text-sm">{{ salePricePsqm }}</p>
                </div>
            </div>
        </div>
    </div>
    
    <div class="lg:flex p-3">
        <div class="lg:w-2/3 lg:pr-6">
            
            <div class="shadow-lg rounded bg-card">
                
                <template v-if="isLoaded" >
                    <Gallery :listingId="listingId" />
                </template>
                <div v-else class="mt-3 h-112 bg-muted"></div>
            </div>

            <div v-show="isLoaded" class="shadow-lg rounded mt-4 p-4 bg-card">
                <div class="grid grid-cols-3">
                    <div>
                        <h6 class="text-sm text-muted-foreground">Status</h6>
                        <p class="text-black text-lg">{{ statusLabel }}</p>
                    </div>
                    <div>
                        <h6 class="text-sm text-muted-foreground">Available On</h6>
                        <p class="text-black text-lg">{{ property.formatted_display_availability }}</p>
                    </div>
                    <div>
                        <h6 class="text-sm text-muted-foreground">Last Updated</h6>
                        <p class="text-black text-lg">{{ property.formatted_display_last_updated }}</p>
                    </div>
                    <div class="mt-2">
                        <h6 class="text-sm text-muted-foreground">Minimum Lease Term</h6>
                        <p class="text-black text-lg">{{ minLeaseTerm }}</p>
                    </div>
                    <div class="mt-2">
                        <h6 class="text-sm text-muted-foreground">Security Deposit</h6>
                        <p class="text-black text-lg">{{ securityDeposit }}</p>
                    </div>
                    <div class="mt-2">
                        <h6 class="text-sm text-muted-foreground">Advance Rental</h6>
                        <p class="text-black text-lg">{{ advanceRental }}</p>
                    </div>
                </div>
            </div>

            <div class="shadow-lg rounded mt-4 p-4 bg-card">
                <h6 class="text-lg text-muted-foreground font-medium mb-1">Attributes</h6>
                <div>                    
                    <div v-for="(attribute, index) in attributes" :key="index" class="inline-flex rounded-lg py-1.5 px-2.5 bg-muted text-muted-foreground mr-2 mt-2"><span class="">{{attribute.attr}}</span>&nbsp;&nbsp;<span class="font-bold">{{attribute.value}}</span></div>                                                           
                </div>
            </div>

            <div v-show="property.amenities && property.amenities.length > 0" class="shadow-lg rounded mt-4 p-4 bg-card">
                <h6 class="text-lg text-muted-foreground font-medium mb-2">Building Amenities & Unit Features</h6>
                <div>
                    <div v-for="(amenity, index) in property.amenities" :key="index" class="inline-flex rounded-lg py-1.5 px-2.5 bg-muted text-muted-foreground mr-2 mt-2">
                        {{amenity.name}}
                    </div>
                </div>
            </div>
        </div>

        <div class="lg:w-1/3 lg:pl-6 sm:mt-4 lg:mt-0 md:mt-4">
            <div class="shadow-lg rounded p-4 bg-card">                
                <div class="text-muted-foreground" v-html="sanitizeListingHtml(description)"></div>
            </div>

            <div class="mt-4">
                <InquiryForm v-if="isLoaded" :referrerUrl="property.url_link" :model="`property`" :modelId="property.id" />
            </div>
        </div>
    </div>
  </div>
</template>

<script>

import pick from 'lodash/pick'
import listingService from '@/services/listing.services'
import Gallery from '@/components/pages/listings/GalleryListingPreview'
import InquiryForm from '@/components/pages/inquiries/Form'
import { formatMoney } from '~/helpers/formatMoney'

  export default {
    head() {
      return {
        title: `${this.headTitle} | Housinginteractive.com.ph`
      }
    },
    middleware: ['auth'],
    mixins: [listingService],
    components: {
        Gallery, InquiryForm
    },    
    data() {
      return {
        listingId : null,
        property : {},
        isLoaded : false
      }
    },
    computed : {        
        address() {
            let str = '', arr = [];
            if(this.isLoaded) {                
                if(this.property.metadata.unit_number) arr.push(this.property.metadata.unit_number);                
                if(this.property.metadata.street) arr.push(this.property.metadata.street);                
                if(this.property.building) arr.push(this.property.building.name);
                if(this.property.area) arr.push(this.property.area.name);
                if(this.property.city) arr.push(this.property.city.name);
                str = arr.join(', ');
            }
            return str;
        },        
        attributes() {
            let arr = [];
            const arrAttrs = {bedrooms : 'Bedrooms', bathrooms : 'Bathrooms', car_space : 'Parking Space'};            
            if(this.property.metadata) {                  
                const arrPick = pick(this.property.metadata, Object.keys(arrAttrs));
                for (const key in arrPick) {
                    if(arrPick[key] != '0') {
                        arr.push({attr : arrAttrs[key], value : arrPick[key]});
                    }
                }               
            }
            if(this.property.condition) {
                arr.push({attr : 'Property Condition', value : this.property.condition.name});
            }
            arr.push({attr : "Flooar Area", value : this.property.floor_area});  
            arr.push({attr : "Lot Area", value : this.property.lot_area});  
            return arr;
        },
        description() {
            let str = '';
            if(this.property.metadata) str = this.property.metadata.description ?? '';            
            return str;
        },
        headTitle() {
            return this.property.name ?? 'Property';
        },        
        statusLabel()
        {
            return this.property.status ? this.property.status.name : '';
        },
        minLeaseTerm() {
            return this.property.metadata && this.property.metadata.minimum_lease_term ? 
                    this.property.metadata.minimum_lease_term + ' ' + this.capitalize(this.property.metadata.minimum_lease_term_unit)
                    : '';
        },        
        securityDeposit() {
            return this.property.metadata && this.property.metadata.deposit ? 
                    this.property.metadata.deposit + ' ' + this.capitalize(this.property.metadata.deposit_unit)
                    : '';
        },
        advanceRental() {
            return this.property.metadata && this.property.metadata.advance ? 
                    this.property.metadata.advance + ' ' + this.capitalize(this.property.metadata.advance_unit)
                    : '';
        },
        rentalPrice() {            
            return this.property.rent_price ? this.formatMoney(this.property.rent_price) : '-';
        },
        salePrice() {
            return this.property.sale_price ? this.formatMoney(this.property.sale_price) : '';
        },
        rentalPricePsqm() {
            return this.property.rent_pps ? this.formatMoney(this.property.rent_pps) + '/Sqm': '';
        },
        salePricePsqm() {
            return this.property.rent_pps ? this.formatMoney(this.property.rent_pps) + '/Sqm': '';
        }
           
    },
    methods : {
        async fetchData()
        {
            try {
                this.property = await this._getListing(this.listingId);
                this.isLoaded = true;
            }
            catch(error) {
                // console.log(error);
            }
        },

        pageHit()
        {            
            this._pageHitListing(this.listingId);                            
        },

        capitalize(str) {
            str = str.toString();
            return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
        },

        formatMoney(value) {
            return formatMoney(value)
        }
    },
    mounted() {
        this.listingId = this.$route.params.id;
        this.fetchData();  
        this.pageHit();   
    }
  }
</script>