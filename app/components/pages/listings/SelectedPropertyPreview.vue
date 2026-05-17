<template>
    
    <div>
        <!-- Preview -->
        <div class="flex flex-col flex-1 " v-show="modal.page === 1">

            <div class="hi-search flex flex-1 h-12 bg-card m-3 px-3 py-2 border border-grey focus-within:border-blue rounded-lg">
                <font-awesome-icon icon="magnifying-glass" class="mr-3 mt-2 text-muted-foreground" />
                <div class="w-full relative">
                    <input type="text" v-on:input="searchSuggestion" placeholder="Search keywords..."  
                        v-model="searchQueryParams.search"                              
                        class="flex-1 w-full focus:outline-none focus:shadow-none focus:ring-0 mt-1 border-0 font-bold placeholder-gray-3" />
                    <SuggestionBox :suggestions="suggestions" v-if="suggestionBoxStatus"
                        v-on:input="suggestionsInput" v-on-clickaway="closeSuggestionBox" />
                </div>

                <span class="cursor-pointer mr-2 w-8 h-8 text-center pt-1.5 bg-muted inline-block rounded-lg"
                    title="Reset Search" @click="resetSuggestionSearch">
                    <font-awesome-icon icon="recycle" />
                </span> 

                <Dropdown :columns="searchColumns" v-model="searchQueryParams.searchColumn" v-on:input="searchColumnsInput" />               

            </div>

            <table class="min-w-full leading-normal">
                <thead>
                    <tr>
                        <th
                            class="px-5 py-3 border-b-2 border-border bg-muted text-left text-xs font-semibold text-foreground uppercase tracking-wider">

                            ID
                        </th>
                        <th
                            class="px-5 py-3 border-b-2 border-border bg-muted text-left text-xs font-semibold text-foreground uppercase tracking-wider">
                            Name
                        </th>
                        <th
                            class="px-5 py-3 border-b-2 border-border bg-muted text-left text-xs font-semibold text-foreground uppercase tracking-wider">
                            R/S
                        </th>
                        <th
                            class="px-5 py-3 border-b-2 border-border bg-muted text-left text-xs font-semibold text-foreground uppercase tracking-wider">
                            Opt
                        </th>
                    </tr>
                </thead>
                <draggable v-model="listingsCopy" tag="tbody" class="text-xs" item-key="id">
                    <template #item="{ element: listing, index }">
                        <tr :class="{'bg-muted': index % 2}" class="cursor-pointer">
                            <!-- Listing Name -->
                            <td class="px-5 py-2 border-b border-border bg-card text-xs">
                                <div class="flex gap-3">
                                    <i class="fas fa-bars"></i>
                                    <p class="whitespace-no-wrap cursor-pointer text-primary">
                                        <span class="my-auto">{{listing.id}}</span>
                                    </p>
                                </div>

                            </td>
                            <td class="px-5 py-2 border-b border-border bg-card text-xs">
                                <p class="whitespace-no-wrap cursor-pointer text-primary">
                                    {{ unitNumberWithBuilding(listing) }}
                                </p>
                            </td>
                            <td class="px-5 py-2 border-b border-border bg-card text-xs">
                                <div class="whitespace-no-wrap cursor-pointer text-primary">
                                <div class="text-black">
                                    <span v-if="listing.is_for_sale">
                                        Sale
                                    </span>
                                    <span v-if="listing.is_for_sale && listing.is_for_rent">/</span>
                                    <span v-if="listing.is_for_rent">
                                        Rent
                                    </span>
                                </div>
                                </div>
                            </td>
                            <td class="px-5 py-2 border-b border-border bg-card text-xs">
                                <button type="button" class="w-full h-6 px-2 text-sm text-red text-left"
                                    @click="remove(listing.id)">
                                    <font-awesome-icon icon="xmark" />
                                </button>
                            </td>
                        </tr>
                    </template>
                </draggable>

                <tbody v-if="!listingsCopy.length">
                    <tr>
                        <td colspan="4">
                            <div class="text-center w-full py-2 text-sm">No listings to display.</div>
                        </td>
                    </tr>
                </tbody>

            </table>

            <span class="block h-12"></span>

            <div class="flex justify-between pb-4 px-4">
                <div></div>
                <div>                    
                    <button type="button" class="w-39 h-9 ml-auto bg-green rounded-lg" v-show="listingsCopy.length"
                        @click="modal.page = 2">
                        <span class="inline-block text-white font-bold mt-0.5">Report Information</span>
                    </button>
                </div>
            </div>

        </div>

        <!-- Generate -->
        <div class="flex flex-col flex-1 p-4" v-show="modal.page === 2">
            <div class="pb-2">
                <Input id="description" type="text" v-model="form.client_name" :error="errors.client_name"
                    placeholder="Client Name">Client Name</Input>
            </div>
            <div class="pb-2 mt-2">
                <Input id="description" type="date" rows="3" v-model="form.date" :error="errors.date"
                    placeholder="Date">Date</Input>
            </div>
            <div class="pb-2 mt-2 ">
                <Input id="description" type="time" v-model="form.time" :error="errors.time"
                    placeholder="Time">Time</Input>
            </div>
            <span class="block h-12"></span>

            <div class="flex justify-between pb-4 px-4">
                <div></div>
                <button type="button" class="w-39 h-9 ml-auto bg-green rounded-lg" v-show="listingsCopy.length"
                    @click="generateReport()">
                    <span class="inline-block text-white font-bold mt-0.5">Generate Report</span>
                </button>
            </div>
        </div>
    </div>
</template>

<script>
    import { apiRoutes } from "~/contants";
    import debounce from 'lodash/debounce';
    import Auth from "~/mixins/auth";
    import Modals from "~/mixins/modals";
    import Owners from "~/mixins/domains/owners";
    import listingService from '@/services/listing.services';
    import Close from 'vue-material-design-icons/Close.vue';
    import Input from "~/components/Input.vue";
    import draggable from 'vuedraggable'
    import Dropdown from '~/components/Dropdown'
    import SuggestionBox from '@/components/pages/listings/PropertyPreviewSuggestionBox'
    import { library } from '@fortawesome/fontawesome-svg-core'
    import { faRecycle, faXmark } from '@fortawesome/free-solid-svg-icons'

    library.add(faRecycle, faXmark)

    import {
        dismissLoading,
        showLoading,
        showToast,
    } from "~/helpers/helpers";

    export default {
        mixins: [Auth, Modals, Owners, listingService],
        props: {            
            isOpen: {
                type: Boolean
            },
            division: {
                type: [String, Number],
                required: true
            },
            searchColumns : {
                type : Object,
                default : {}
            },
            selectedListings : {
                type : Array,
                default : []
            }
        },
        components:
        {
            Input,
            Close,
            draggable,
            Dropdown,
            SuggestionBox
        },
        computed: {
            isVisible() {
                this.modal.title = (this.modal.page === 1) ? 'Property Preview' : 'Report Information';
                return this.isOpen;
            },
        },
        data() {
            return {
                listingsCopy: this.selectedListings,
                form:
                {
                    client_name: "",
                    date: "",
                    time: ""
                },
                errors:
                {
                    client_name: '',
                    date: '',
                    time: '',
                },
                modal: {
                    title: 'Property Preview',
                    page: 1,

                },

                // for searchbox 
                searchQuery : null,
                searchQueryParams : {
                    searchColumn : 'id',
                    division : this.division,
                    search : null
                },
                suggestions : [],
                suggestionBoxStatus : false
            }
        },        
        methods: {

            suggestionsInput(value) {   
                const blnAdded = this.listingsCopy.find(item => item.id == value);

                if(!blnAdded) {
                    const listing = this.suggestions.find( item => item.id == value);
                    //this.listingsCopy.push(listing);
                    this.$emit('addListing', listing);     
                }   

                this.closeSuggestionBox();
                this.searchQueryParams.search = null;
            },
            
            searchSuggestion: debounce(function (e) {               
                this.searchSuggestionFetch(e.target.value)
            }, 1000),

            searchSuggestionFetch(query) {
                if(query) {                                  
                    this.getListings()
                }  
                else {
                    this.suggestionBoxStatus = false
                }  
            },

            resetSuggestionSearch() {
                this.searchQueryParams.search = null;
                this.closeSuggestionBox();
            },

            searchColumnsInput() {
                this.searchSuggestionFetch(this.searchQueryParams.search)
            },

            async getListings() {
                //await showLoading()
                try {
                    const table = await this._getListings(this.searchQueryParams);
                    this.suggestions = table.data;
                    this.suggestionBoxStatus = true;
                } catch (error) {
                    
                }
                
                //dismissLoading()
            },

            closeSuggestionBox() {
                this.suggestionBoxStatus = false
            },

            close() {
                this.$emit('close');
                //this.modal.page = 1;
                //this.resetErrorMessages();
            },
            remove(id) {
                //this.$emit('renderCheckbox', this.listingsCopy[index].id);
                this.listingsCopy = this.listingsCopy.filter(item => item.id != id)
                this.$emit('removeListing', id)
            },
            resetErrorMessages() {
                const keys = Object.keys(this.form);
                keys.forEach((key) => {
                    this.errors[key] = '';
                });
            },

            async generateReport() {
                let isEmpty = false;
                const keys = Object.keys(this.form);
                const divisionCode = (this.division == 1) ? 'residential' : 'commercial';
                this.resetErrorMessages();
                keys.forEach((key) => {
                    if (!this.form[key]) {
                        this.errors[key] = '*This field is required.';
                        isEmpty = true;
                    }
                });
                if (isEmpty) return false;
                await showLoading();
                const body = {
                    ...this.form,
                    listings: this.listingsCopy.map(item => item.id),
                    division: divisionCode
                };
                const url = (this.division == 1) ? apiRoutes['generate.residential.report'] : apiRoutes['generate.commercial.report'];
                this.$axios.$post(url, body)
                    .then(res => {
                        const documentUrl = res.document_url;
                        const link = document.createElement('a');
                        link.href = documentUrl;
                        link.click();
                        link.remove();
                        dismissLoading();
                        this.close();
                        showToast({ title: 'Downloading please wait...' });
                        //this.$router.push({ path: 'docs', query: { tab: 'viewing-list', division : divisionCode } })                        
                        this.$router.push({ path: 'document-lists', query: { division : divisionCode } })                        
                    }).catch(() => {
                        dismissLoading();
                        alert('Oops. Something went wrong. Please try again later.');
                    });

            },  
            unitNumberWithBuilding(listing) {
                return listing.building_name 
                    ? 
                    `${listing.unit_number} - ${listing.building_name}`
                    :
                    listing.unit_number;      
            }          
        }
    }
</script>

<style scoped>
    .list-move {
        transition: .5s;
    }
</style>