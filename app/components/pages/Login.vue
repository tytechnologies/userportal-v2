<template>
  <div class="w-full lg:max-h-screen overflow-y-auto">
    <div
      class="md:w-full lg:max-w-4xl flex flex-col mx-auto pb-24 p-8 overflow-y-auto"
    >
      <div class="mx-auto">
        <img
          class="object-scale-down mb-20"
          src="/img/cityscapes.png"
          alt="Cityscapes"
        />
      </div>
      <h1
        class="text-xl sm:text-2xl md:text-3xl lg:text-4xl font-bold mx-auto text-center"
      >
        Streamline the way you manage your real estate business
      </h1>
      <p
        class="max-w-3xl text-base lg:text-2xl mx-auto text-center font-medium text-gray-350"
      >
        Manage listings, attend to leads, discover properties, and organize
        documents with one dashboard
      </p>
      <!-- <ul class="flex flex-wrap mx-auto my-12">
                <li class="mx-7 sm:mx-3 md:mx-3 my-4"><img class="object-scale-down" src="/img/cnn.png" alt="CNN"></li>
                <li class="mx-7 sm:mx-3 md:mx-3 my-4"><img class="object-scale-down" src="/img/cnn.png" alt="CNN"></li>
                <li class="mx-7 sm:mx-3 md:mx-3 my-4"><img class="object-scale-down" src="/img/cnn.png" alt="CNN"></li>
                <li class="mx-7 sm:mx-3 md:mx-3 my-4"><img class="object-scale-down" src="/img/cnn.png" alt="CNN"></li>
                <li class="mx-7 sm:mx-3 md:mx-3 my-4"><img class="object-scale-down" src="/img/cnn.png" alt="CNN"></li>
                <li class="mx-7 sm:mx-3 md:mx-3 my-4"><img class="object-scale-down" src="/img/cnn.png" alt="CNN"></li>
            </ul> -->
      <div class="mx-auto my-12">
        <img
          class="drop-shadow-3xl rounded-md"
          src="/img/wireframe.jpg"
          alt="Wireframe"
        />
      </div>
      <div
        class="flex flex-wrap justify-center mx-auto gap-8 text-center py-24"
      >
        <div class="font-bold flex flex-col">
          <span class="text-5xl block">7,319</span>
          <span class="text-base">Total Contracts</span>
        </div>
        <div class="font-bold flex flex-col">
          <span class="text-5xl block">3,462</span>
          <span class="text-base"
            >Residential list <br />
            brokers</span
          >
        </div>
        <div class="font-bold flex flex-col">
          <span class="text-5xl block">857</span>
          <span class="text-base"
            >Commercial list <br />
            brokers</span
          >
        </div>
        <div class="font-bold flex flex-col">
          <span class="text-5xl block">3,000</span>
          <span class="text-base">Client report</span>
        </div>
      </div>
      <div class="flex flex-wrap sm:flex-nowrap text-xl w-full gap-6 mb-8">
        <div class="w-full sm:w-1/2 md:w-1/2 lg:w-1/2">
          <!-- <span class="block w-20 h-20 bg-muted rounded-full mx-auto sm:m-0 md:m-0 lg:m-0">&nbsp;</span> -->
          <h3 class="text-xl font-bold my-4">Manage your property listings</h3>
          <p class="text-base font-medium text-muted-foreground/70">
            We know how overwhelming it can be to maintain your property
            listings. That’s why with HousingInteractive, updating your
            properties has never been easier. We've designed our platform to
            make the process as smooth as possible. You can effortlessly modify
            the price, information, and pictures of your listings without
            breaking a sweat. What's more, you can quickly organize your
            listings by upload date and last update, giving you peace of mind
            that everything is up-to-date and looking its best.
          </p>
        </div>
        <div class="w-full sm:w-1/2 md:w-1/2 lg:w-1/2">
          <!-- <span class="block w-20 h-20 bg-muted rounded-full mx-auto sm:m-0 md:m-0 lg:m-0">&nbsp;</span> -->
          <h3 class="text-xl font-bold my-4">Attend to pre-qualified leads</h3>
          <p class="text-base font-medium text-muted-foreground/70">
            You deserve to work with the most qualified leads for your property.
            That's why at HousingInteractive, we make sure that every inquiry is
            pre-qualified by our team before reaching you. We understand how
            precious your time is, and we want to ensure that you're only
            getting warm, high-quality leads who are genuinely interested in
            your listing. So, sit back and relax, and let us do the heavy
            lifting of sifting through inquiries, leaving you with only the best
            leads to connect with.
          </p>
        </div>
      </div>
      <div class="flex flex-wrap sm:flex-nowrap w-full gap-6">
        <div class="w-full sm:w-1/2 md:w-1/2 lg:w-1/2">
          <!-- <span class="block w-20 h-20 bg-muted rounded-full mx-auto sm:m-0 md:m-0 lg:m-0">&nbsp;</span> -->
          <h3 class="text-xl font-bold my-4">
            Discover properties for your leads
          </h3>
          <p class="text-base font-medium text-muted-foreground/70">
            Are you struggling to find the perfect property for your clients?
            We've got you covered! Search from thousands of exclusive properties
            for sale and rent on our platform. We've handpicked only the best
            listings, so you can rest assured that you're getting the cream of
            the crop. And the best part? You can connect directly with the
            listing agent or owner from the dashboard. No more wasting time on
            back-and-forth emails or phone calls. We're here to make your
            property search as seamless and stress-free as possible.
          </p>
        </div>
        <div class="w-full sm:w-1/2 md:w-1/2 lg:w-1/2">
          <!-- <span class="block w-20 h-20 bg-muted rounded-full mx-auto sm:m-0 md:m-0 lg:m-0">&nbsp;</span> -->
          <h3 class="text-xl font-bold my-4">Organize Documents</h3>
          <p class="text-base font-medium text-muted-foreground/70">
            We understand that completing documents is a crucial step in any
            real estate transaction. That's why we've gone above and beyond to
            make your life easier. We've curated a collection of the most
            commonly used real estate forms and templates that you can download,
            fill out, and send directly to your device or clients. No more
            struggling to find the right forms or worrying about whether you've
            filled them out correctly. We've got your back every step of the
            way, so you can focus on what really matters - closing that deal!
          </p>
        </div>
      </div>
    </div>
    <Footer />
  </div>
</template>

<script>
import Footer from '~/components/Footer'

export default {
  components: { Footer },
}
</script>
